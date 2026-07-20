# Option A — what you're running now (recommended, simplest)
Your existing kc container already has the realm/client/user I created. Day-to-day you only need:

```docker start kc```        # boot Keycloak (after reboot etc.)
```docker stop kc```         # shut it down
If you ever delete it and need to recreate it from scratch:

```docker run -d --name kc -p 8180:8080 \```
  ```-e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \```
  ```-v keycloak-data:/opt/keycloak/data \```
  ```quay.io/keycloak/keycloak:24.0 start-dev```

The -v keycloak-data:... volume is the important addition — your current container doesn't have one, so docker rm kc would wipe the realm and you'd have to recreate info-root-local / web-spa / the user in the admin console.

Then the full local startup is:

```docker start kc```

```cd C:\Users\USER\Desktop\Freelance\inforoot\SummariesBotv2```

```python -m uvicorn app:app --host 0.0.0.0 --port 8000```
→ http://localhost:8000, login admin / admin123.

# Option B — the repo's docker-compose.yml
It expects these in .env first (the file already has KEYCLOAK_ISSUER; add these below it):

KC_DB_NAME=keycloak
KC_DB_USER=keycloak
KC_DB_PASSWORD=keycloak
KC_ADMIN_USER=admin
KC_ADMIN_PASSWORD=admin

Then start only the Keycloak services — do not run the full compose, because its postgres service maps 5432 which collides with your native Postgres (the one holding summariesbotdb):

```docker compose up -d keycloak-db keycloak```
Two caveats with Option B: stop your current kc first (docker stop kc) since both want port 8180, and it's a fresh Keycloak instance — the realm/client/user would need to be created again inside it.

**My advice: stick with Option A. Compose only buys you something if you later move Postgres/Redis into Docker too.**