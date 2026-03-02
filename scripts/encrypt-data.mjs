import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { webcrypto } from "node:crypto";

const MAGIC = "WREELS";
const VERSION = 1;
const DEFAULT_ITERATIONS = 250_000;
const DEFAULT_IN = "data.json";
const DEFAULT_OUT = "data.bin";

const encoder = new TextEncoder();

function usage() {
  return [
    "Usage:",
    "  node scripts/encrypt-data.mjs --in data.json --out data.bin",
    "",
    "Options:",
    "  --in <path>           Input JSON (default: data.json)",
    "  --out <path>          Output BIN (default: data.bin)",
    "  --iterations <int>    PBKDF2 iterations (default: 250000)",
    "  --password <string>   Password (avoid: may end up in shell history)",
    "",
    "Env:",
    "  DATA_PASSWORD         Password (recommended for non-interactive)",
  ].join("\n");
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) out[key] = "true";
    else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function exitWith(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function uint32ToBytesBE(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, value >>> 0, false);
  return new Uint8Array(buf);
}

async function deriveKey({ password, salt, iterations }) {
  const keyMaterial = await webcrypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return webcrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptToBin({ plaintextBytes, password, iterations }) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey({ password, salt, iterations });
  const cipherBuf = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBytes);
  const ciphertext = new Uint8Array(cipherBuf);

  const magicBytes = encoder.encode(MAGIC);
  const headerLen = 6 + 1 + 4 + 1 + 1;
  const out = new Uint8Array(headerLen + salt.length + iv.length + ciphertext.length);

  let offset = 0;
  out.set(magicBytes, offset);
  offset += magicBytes.length;
  out[offset] = VERSION;
  offset += 1;
  out.set(uint32ToBytesBE(iterations), offset);
  offset += 4;
  out[offset] = salt.length;
  offset += 1;
  out[offset] = iv.length;
  offset += 1;
  out.set(salt, offset);
  offset += salt.length;
  out.set(iv, offset);
  offset += iv.length;
  out.set(ciphertext, offset);
  offset += ciphertext.length;

  return out;
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY) exitWith("No TTY available for password prompt. Set DATA_PASSWORD instead.");

  process.stdout.write(prompt);
  const stdin = process.stdin;
  const prevRawMode = stdin.isRaw;
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.setRawMode(true);

  /** @type {string[]} */
  const chars = [];
  return await new Promise((resolve) => {
    function cleanup() {
      stdin.setRawMode(Boolean(prevRawMode));
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    }

    /** @param {string} chunk */
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          cleanup();
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(chars.join(""));
          return;
        }
        if (ch === "\u007f") {
          chars.pop();
          continue;
        }
        chars.push(ch);
      }
    }

    stdin.on("data", onData);
  });
}

async function getPassword(args) {
  if (args.password) return args.password;
  if (process.env.DATA_PASSWORD) return process.env.DATA_PASSWORD;

  const pass1 = await promptHidden("Password: ");
  const pass2 = await promptHidden("Confirm:  ");
  if (pass1 !== pass2) exitWith("Passwords did not match.");
  if (!pass1) exitWith("Password cannot be empty.");
  return pass1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }

  const inPath = args.in ? String(args.in) : DEFAULT_IN;
  const outPath = args.out ? String(args.out) : DEFAULT_OUT;
  const iterations = args.iterations ? Number.parseInt(String(args.iterations), 10) : DEFAULT_ITERATIONS;

  if (!Number.isFinite(iterations) || iterations < 50_000) exitWith("--iterations must be a number >= 50000.");

  const absIn = path.resolve(inPath);
  const absOut = path.resolve(outPath);
  if (absIn === absOut) exitWith("--in and --out must be different files.");

  let jsonText = "";
  try {
    jsonText = await fs.readFile(absIn, "utf8");
  } catch (err) {
    exitWith(`Failed to read input: ${absIn}\n${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    JSON.parse(jsonText);
  } catch (err) {
    exitWith(`Input is not valid JSON: ${absIn}\n${err instanceof Error ? err.message : String(err)}`);
  }

  const password = await getPassword(args);
  const plaintextBytes = encoder.encode(jsonText);
  const bin = await encryptToBin({ plaintextBytes, password, iterations });

  await fs.writeFile(absOut, Buffer.from(bin));
  console.log(`Wrote ${bin.length} bytes → ${path.relative(process.cwd(), absOut)}`);
}

main().catch((err) => exitWith(err instanceof Error ? err.stack || err.message : String(err)));

