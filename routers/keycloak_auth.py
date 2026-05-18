"""
Keycloak JWT verifier — auth-only mode.

Validates `Authorization: Bearer <jwt>` tokens issued by Keycloak by:
  1. Fetching the realm's JWKS once (with TTL + signing-key cache).
  2. Verifying signature, issuer, and exp.
  3. Returning the parsed claims dict on success, or None on any failure.

The verifier is intentionally permissive about audience/roles for now —
the user requested authentication-only; role enforcement is a follow-up.

Configured via env vars:
  KEYCLOAK_ISSUER     full issuer URL, e.g. http://localhost:8180/realms/inforoot
  KEYCLOAK_JWKS_URL   override for the JWKS endpoint (optional; derived from issuer otherwise)

If KEYCLOAK_ISSUER is unset, is_keycloak_enabled() returns False and the rest
of the auth stack continues to use the native opaque-token flow only.
"""

import os
import time
import logging
from typing import Optional

import jwt
from jwt import PyJWKClient

logger = logging.getLogger(__name__)

KEYCLOAK_ISSUER = os.environ.get("KEYCLOAK_ISSUER", "").rstrip("/")
KEYCLOAK_JWKS_URL = os.environ.get("KEYCLOAK_JWKS_URL") or (
    f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs" if KEYCLOAK_ISSUER else ""
)

logger.info(
    f"[keycloak] module loaded — ISSUER='{KEYCLOAK_ISSUER or '(unset)'}' "
    f"JWKS_URL='{KEYCLOAK_JWKS_URL or '(unset)'}'"
)

_jwks_client: Optional[PyJWKClient] = None


def is_keycloak_enabled() -> bool:
    return bool(KEYCLOAK_ISSUER)


def _get_jwks_client() -> Optional[PyJWKClient]:
    global _jwks_client
    if not KEYCLOAK_JWKS_URL:
        return None
    if _jwks_client is None:
        # lifespan=3600 caches resolved signing keys for an hour; PyJWKClient
        # re-fetches JWKS automatically on cache miss / rotation.
        _jwks_client = PyJWKClient(KEYCLOAK_JWKS_URL, lifespan=3600)
    return _jwks_client


def verify_keycloak_jwt(token: str) -> Optional[dict]:
    """Return parsed claims on success, or None on any failure.
    Never raises — caller treats None as 'not a valid Keycloak token'."""
    if not is_keycloak_enabled():
        logger.info("[keycloak] verifier disabled: KEYCLOAK_ISSUER unset")
        return None
    client = _get_jwks_client()
    if client is None:
        logger.warning("[keycloak] no JWKS client (URL unset)")
        return None
    try:
        signing_key = client.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            issuer=KEYCLOAK_ISSUER,
            # audience check disabled — Keycloak SPA tokens often have aud="account"
            # which would force every backend client to be added there. Auth-only
            # mode means signature + issuer + exp are sufficient.
            options={"verify_aud": False},
        )
        logger.info(f"[keycloak] accept: sub={claims.get('preferred_username') or claims.get('sub')}")
        return claims
    except jwt.ExpiredSignatureError:
        logger.info("[keycloak] reject: token expired")
        return None
    except jwt.InvalidIssuerError:
        # Decode without verification just to log what the token actually claimed.
        try:
            raw = jwt.decode(token, options={"verify_signature": False, "verify_exp": False})
            logger.warning(
                f"[keycloak] reject: wrong issuer — token iss='{raw.get('iss')}' "
                f"expected='{KEYCLOAK_ISSUER}'"
            )
        except Exception:
            logger.warning(f"[keycloak] reject: wrong issuer (expected {KEYCLOAK_ISSUER})")
        return None
    except jwt.PyJWTError as e:
        logger.warning(f"[keycloak] reject: {type(e).__name__}: {e}")
        return None
    except Exception as e:
        logger.warning(f"[keycloak] reject (unexpected): {type(e).__name__}: {e}")
        return None
