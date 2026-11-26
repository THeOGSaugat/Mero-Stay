import { startFakeGateways } from "../testing/fake-gateways.js";

/**
 * Local fake eSewa + Khalti for the E2E journeys (playwright.config.ts starts it). Test keys come
 * from the environment (the Playwright config generates random ones per run); never real keys.
 *
 *   FAKE_GATEWAYS_PORT  ESEWA_PRODUCT_CODE  ESEWA_SECRET_KEY  KHALTI_SECRET_KEY  [FAKE_GATEWAYS_LOG=1]
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const fake = await startFakeGateways(
  {
    esewa: {
      productCode: required("ESEWA_PRODUCT_CODE"),
      secretKey: required("ESEWA_SECRET_KEY"),
    },
    khalti: { secretKey: required("KHALTI_SECRET_KEY") },
  },
  {
    port: Number(required("FAKE_GATEWAYS_PORT")),
    // FAKE_GATEWAYS_LOG=1: one line per request (method, path, status; never bodies or keys).
    ...(process.env.FAKE_GATEWAYS_LOG === "1"
      ? { log: (line: string) => process.stderr.write(`fake-gateways: ${line}\n`) }
      : {}),
  },
);
process.stdout.write(`fake payment gateways listening on ${fake.baseUrl}\n`);

const stop = () => {
  void fake.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
