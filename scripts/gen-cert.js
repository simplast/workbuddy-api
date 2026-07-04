import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const CERTS_DIR = path.resolve("certs");
const KEY_PATH = path.join(CERTS_DIR, "localhost.key");
const CERT_PATH = path.join(CERTS_DIR, "localhost.crt");
const VALID_DAYS = 365;

function main() {
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    console.log(`Created directory: ${CERTS_DIR}`);
  }

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days ${VALID_DAYS} -subj "/C=CN/ST=Beijing/L=Beijing/O=workbuddy/OU=proxy/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"`,
      { stdio: "ignore" }
    );

    console.log(`\n✦ Self-signed certificate generated successfully!`);
    console.log(`  Key:    ${KEY_PATH}`);
    console.log(`  Cert:   ${CERT_PATH}`);
    console.log(`  Validity: ${VALID_DAYS} days`);
    console.log(`\nTo use HTTPS, add to your .env:`);
    console.log(`  HTTPS_ENABLED=1`);
    console.log(`\nNote: Browsers will show a security warning for self-signed certificates.`);
    console.log(`For local development, you can add the certificate to your trusted store.`);
  } catch (err) {
    console.error(`\n✗ Failed to generate certificate: ${err.message}`);
    console.error(`Make sure OpenSSL is installed on your system.`);
    console.error(`On macOS: brew install openssl`);
    console.error(`On Ubuntu: sudo apt install openssl`);
    process.exit(1);
  }
}

main();