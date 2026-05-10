import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.yaml');

/**
 * Read admin credentials from config.yaml so the test suite logs in the same
 * way the Python tests do (conftest.py:_load_admin_creds). Failing here is a
 * fatal setup error — every test depends on a valid admin token.
 */
export function loadAdminCreds() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = yaml.load(raw);
  const adm = cfg?.admin || {};
  const username = adm.username || 'admin';
  const password = adm.password;
  if (!password) {
    throw new Error(`No admin.password in ${CONFIG_PATH} — cannot log in.`);
  }
  return { username, password };
}
