// Imported first by the entry points: refuse to run on unsupported Node.js versions.
const REQUIRED = 24;
const major = Number(process.versions.node.split('.')[0]);
if (major < REQUIRED) {
  console.error(`rustdesk-web requires Node.js ${REQUIRED} or newer; this is ${process.version}.`);
  process.exit(1);
}
