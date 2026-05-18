import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// Self-registration is disabled now that auth goes through Keycloak.
// Account creation happens in the Keycloak admin console; this page just
// bounces to /login (which itself redirects to the Keycloak sign-in screen).
export default function RegisterPage() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/login', { replace: true });
  }, [navigate]);
  return null;
}
