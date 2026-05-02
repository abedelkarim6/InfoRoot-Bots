"""
Auth endpoint tests.
"""
from conftest import ok


def test_me_returns_user(admin_client):
    resp = admin_client.get("/api/auth/me")
    data = ok(resp, "GET /api/auth/me")
    assert "username" in data or "user" in data, \
        f"/api/auth/me response missing username: {data}"


def test_login_wrong_password(admin_client):
    import httpx, os
    client = httpx.Client(base_url=os.getenv("TEST_BASE_URL", "http://localhost:8000"), timeout=10)
    resp = client.post("/api/auth/login", json={"username": "admin", "password": "__wrong__"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "error", "Wrong password should return status=error"
    client.close()


def test_protected_endpoint_without_token():
    import httpx, os
    client = httpx.Client(base_url=os.getenv("TEST_BASE_URL", "http://localhost:8000"), timeout=10)
    resp = client.get("/api/bots")
    assert resp.status_code in (401, 403), \
        f"Unauthenticated request should be rejected, got {resp.status_code}"
    client.close()
