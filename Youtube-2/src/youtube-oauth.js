// Shared YouTube OAuth helper for the auth + upload scripts.
//
// Uploading a video acts ON BEHALF OF the channel owner, so it needs OAuth
// (an API key only works for public reads). This locates the downloaded OAuth
// *client secret* in the project root, builds an OAuth2 client, and loads/saves
// the token. The Youtube-2 credential's redirect URI is localhost:5858, which
// matches the default PORT below.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { google } from "googleapis";
import { projectRoot } from "./env.js";

// Upload + manage (thumbnails.set / metadata) need these two scopes.
export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

export const TOKEN_PATH = join(projectRoot, ".youtube-token.json");
export const PORT = Number(process.env.OAUTH_PORT || 5858);
export const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

// Find the OAuth client secret JSON downloaded from Google Cloud Console.
// Looks for $GOOGLE_OAUTH_CLIENT, then oauth_client.json, then client_secret*.json.
export function findClientSecretFile() {
  const explicit = process.env.GOOGLE_OAUTH_CLIENT;
  if (explicit && existsSync(explicit)) return explicit;

  const named = join(projectRoot, "oauth_client.json");
  if (existsSync(named)) return named;

  const match = readdirSync(projectRoot).find(
    (f) => f.startsWith("client_secret") && f.endsWith(".json")
  );
  if (match) return join(projectRoot, match);

  throw new Error(
    "No OAuth client secret found. Download one from Google Cloud Console " +
      "(APIs & Services → Credentials → OAuth client ID) and save it in the " +
      "Youtube-2 root as oauth_client.json (or leave the client_secret*.json there)."
  );
}

export function makeOAuthClient() {
  const file = findClientSecretFile();
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const cfg = raw.installed || raw.web;
  if (!cfg) throw new Error(`${file} is not a valid OAuth client (no "installed"/"web" key).`);

  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, REDIRECT_URI);
}

// Build an authorized client from the saved token (used by the uploader).
export function authorizedClient() {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error("Not authorized yet. Run `npm run yt:auth` first.");
  }
  const oauth = makeOAuthClient();
  oauth.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, "utf8")));
  return oauth;
}
