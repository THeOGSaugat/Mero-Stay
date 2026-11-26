import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";
import { esewaSignature } from "../lib/payment-gateways/esewa.js";
import { rupeesToPaisa } from "../lib/payment-gateways/amounts.js";

/**
 * Local stand-ins for eSewa ePay v2 and Khalti ePayment v2 (ADR 0017), for integration and E2E
 * tests: no network, no real keys, no real money. They follow the documented contracts the
 * adapters are written against (signed form → signed `data` callback → status API; initiate →
 * payment page → return with `pidx` → lookup), so the adapters are exercised end to end. The
 * opt-in `payment:sandbox-check` script is what talks to the real UAT/sandbox services.
 *
 * Never started in production (refused below).
 */

export interface FakeGatewayKeys {
  esewa: { productCode: string; secretKey: string };
  khalti: { secretKey: string };
}

export interface FakeEsewaTransaction {
  uuid: string;
  productCode: string;
  /** Exactly what our form sent (rupees as text). */
  totalAmount: string;
  status: "PENDING" | "COMPLETE" | "CANCELED" | "NOT_FOUND" | "FULL_REFUND" | "AMBIGUOUS";
  refId: string | null;
  successUrl: string;
  failureUrl: string;
  /** Test control: the amount (rupees, a JSON number) the status API reports instead. */
  statusApiAmount?: number;
}

export interface FakeKhaltiPayment {
  pidx: string;
  /** Paisa, as our server asked. */
  amount: number;
  purchaseOrderId: string;
  purchaseOrderName: string;
  returnUrl: string;
  status: "Initiated" | "Pending" | "Completed" | "Expired" | "User canceled" | "Refunded";
  transactionId: string | null;
  /** Test control: what lookup reports as paid (defaults to `amount`). */
  paidAmount?: number;
}

export interface FakeGateways {
  /** e.g. http://127.0.0.1:53111 */
  baseUrl: string;
  /** Adapter configuration pointing at this server (test keys only). */
  esewaConfig: { productCode: string; secretKey: string; formUrl: string; statusUrl: string };
  khaltiConfig: { secretKey: string; apiUrl: string };
  esewa: {
    transactions: Map<string, FakeEsewaTransaction>;
    /** Marks a transaction paid and returns the signed `data` eSewa would send back. */
    complete(uuid: string, options?: { callbackTotal?: string }): string;
    /** A signed callback for any fields (e.g. tampered or for another payment). */
    signedData(fields: Record<string, string>): string;
  };
  khalti: {
    payments: Map<string, FakeKhaltiPayment>;
    /** Every API call received, with its Authorization header (to check `Key <secret>`). */
    requests: { path: string; authorization: string | undefined; body: unknown }[];
    complete(pidx: string, options?: { paidAmount?: number }): void;
  };
  /** Test control: answer every API call with 503 (gateway down). */
  setUnavailable(down: boolean): void;
  close(): Promise<void>;
}

/** eSewa writes total_amount in callbacks like "1,000.0" (thousands commas, one decimal at least). */
export function esewaCallbackAmount(rupees: string): string {
  const paisa = rupeesToPaisa(rupees);
  if (paisa === null) throw new Error(`not an amount: ${rupees}`);
  const whole = (paisa / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (paisa % 100n).toString().padStart(2, "0").replace(/0$/, "");
  return `${whole}.${fraction || "0"}`;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function withQuery(url: string, params: Record<string, string>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

const ESEWA_CALLBACK_SIGNED = [
  "transaction_code",
  "status",
  "total_amount",
  "transaction_uuid",
  "product_code",
  "signed_field_names",
];

export async function startFakeGateways(
  keys: FakeGatewayKeys,
  options: { port?: number; host?: string; log?: (line: string) => void } = {},
): Promise<FakeGateways> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The fake payment gateways are for tests only.");
  }
  const host = options.host ?? "127.0.0.1";
  const esewaTransactions = new Map<string, FakeEsewaTransaction>();
  const khaltiPayments = new Map<string, FakeKhaltiPayment>();
  const khaltiRequests: FakeGateways["khalti"]["requests"] = [];
  let unavailable = false;

  const signedData = (fields: Record<string, string>): string => {
    const signed = (fields.signed_field_names ?? ESEWA_CALLBACK_SIGNED.join(",")).split(",");
    const all = { ...fields, signed_field_names: signed.join(",") };
    const signature = esewaSignature(keys.esewa.secretKey, all, signed);
    return Buffer.from(JSON.stringify({ ...all, signature }), "utf8").toString("base64");
  };

  const completeEsewa = (uuid: string, opts: { callbackTotal?: string } = {}): string => {
    const txn = esewaTransactions.get(uuid);
    if (!txn) throw new Error(`no eSewa transaction ${uuid}`);
    txn.status = "COMPLETE";
    txn.refId ??= `ESEWA${randomBytes(4).toString("hex").toUpperCase()}`;
    return signedData({
      transaction_code: txn.refId,
      status: "COMPLETE",
      total_amount: opts.callbackTotal ?? esewaCallbackAmount(txn.totalAmount),
      transaction_uuid: txn.uuid,
      product_code: txn.productCode,
    });
  };

  const completeKhalti = (pidx: string, opts: { paidAmount?: number } = {}): void => {
    const payment = khaltiPayments.get(pidx);
    if (!payment) throw new Error(`no Khalti payment ${pidx}`);
    payment.status = "Completed";
    payment.transactionId ??= `KT${randomBytes(6).toString("hex")}`;
    if (opts.paidAmount !== undefined) payment.paidAmount = opts.paidAmount;
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(express.json({ limit: "16kb" }));

  if (options.log) {
    const log = options.log;
    app.use((req, res, next) => {
      res.on("finish", () => log(`${req.method} ${req.path} → ${res.statusCode}`));
      next();
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const down = (res: Response): boolean => {
    if (unavailable) res.status(503).json({ error: "temporarily unavailable" });
    return unavailable;
  };

  // ------------------------------------------------------------------ eSewa
  app.post("/esewa/form", (req: Request, res: Response) => {
    const fields = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
    const signed = (fields.signed_field_names ?? "").split(",");
    const valid =
      fields.product_code === keys.esewa.productCode &&
      signed.join(",") === "total_amount,transaction_uuid,product_code" &&
      fields.signature === esewaSignature(keys.esewa.secretKey, fields, signed) &&
      /^[A-Za-z0-9-]+$/.test(fields.transaction_uuid ?? "") &&
      rupeesToPaisa(fields.total_amount) !== null &&
      Boolean(fields.success_url && fields.failure_url);
    if (!valid) {
      res.status(400).send(page("eSewa (test)", "<p>Invalid payment request.</p>"));
      return;
    }
    const uuid = fields.transaction_uuid as string;
    esewaTransactions.set(uuid, {
      uuid,
      productCode: fields.product_code as string,
      totalAmount: fields.total_amount as string,
      status: "PENDING",
      refId: null,
      successUrl: fields.success_url as string,
      failureUrl: fields.failure_url as string,
    });
    const action = (path: string, label: string) =>
      `<form method="post" action="/esewa/${path}/${encodeURIComponent(uuid)}"><button type="submit">${label}</button></form>`;
    res.send(
      page(
        "eSewa (test)",
        `<p>Pay Rs. ${escapeHtml(fields.total_amount as string)} to ${escapeHtml(keys.esewa.productCode)}</p>${action("pay", "Pay with test eSewa")}${action("cancel", "Cancel eSewa payment")}`,
      ),
    );
  });

  app.post("/esewa/pay/:uuid", (req: Request<{ uuid: string }>, res: Response) => {
    const txn = esewaTransactions.get(req.params.uuid);
    if (!txn) {
      res.status(404).send(page("eSewa (test)", "<p>Unknown payment.</p>"));
      return;
    }
    res.redirect(303, withQuery(txn.successUrl, { data: completeEsewa(txn.uuid) }));
  });

  app.post("/esewa/cancel/:uuid", (req: Request<{ uuid: string }>, res: Response) => {
    const txn = esewaTransactions.get(req.params.uuid);
    if (!txn) {
      res.status(404).send(page("eSewa (test)", "<p>Unknown payment.</p>"));
      return;
    }
    txn.status = "CANCELED";
    res.redirect(303, txn.failureUrl);
  });

  app.get("/esewa/status", (req: Request, res: Response) => {
    if (down(res)) return;
    const query = req.query as Record<string, string | undefined>;
    if (query.product_code !== keys.esewa.productCode) {
      res.status(400).json({ code: 0, error_message: "Invalid product code" });
      return;
    }
    const txn = esewaTransactions.get(query.transaction_uuid ?? "");
    if (!txn) {
      res.json({
        product_code: query.product_code,
        transaction_uuid: query.transaction_uuid,
        total_amount: Number(query.total_amount),
        status: "NOT_FOUND",
        ref_id: null,
      });
      return;
    }
    const paisa = rupeesToPaisa(txn.totalAmount) ?? 0n;
    res.json({
      product_code: txn.productCode,
      transaction_uuid: txn.uuid,
      total_amount: txn.statusApiAmount ?? Number(paisa) / 100,
      status: txn.status,
      ref_id: txn.refId,
    });
  });

  // ------------------------------------------------------------------ Khalti
  const khaltiAuthorized = (req: Request, res: Response): boolean => {
    khaltiRequests.push({
      path: req.path,
      authorization: req.get("authorization"),
      body: req.body as unknown,
    });
    if (down(res)) return false;
    if (req.get("authorization") !== `Key ${keys.khalti.secretKey}`) {
      res.status(401).json({ detail: "Invalid token.", status_code: 401 });
      return false;
    }
    return true;
  };

  const khaltiLookupBody = (p: FakeKhaltiPayment) => ({
    pidx: p.pidx,
    total_amount: p.status === "Completed" ? (p.paidAmount ?? p.amount) : p.amount,
    status: p.status,
    transaction_id: p.status === "Completed" ? p.transactionId : null,
    fee: 0,
    refunded: p.status === "Refunded",
  });

  app.post("/khalti/epayment/initiate/", (req: Request, res: Response) => {
    if (!khaltiAuthorized(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.amount !== "number" ||
      !Number.isInteger(body.amount) ||
      body.amount < 1000 ||
      typeof body.return_url !== "string" ||
      typeof body.website_url !== "string" ||
      typeof body.purchase_order_id !== "string" ||
      typeof body.purchase_order_name !== "string"
    ) {
      res
        .status(400)
        .json({ amount: ["Amount should be greater than Rs. 10, that is 1000 paisa."] });
      return;
    }
    const pidx = randomUUID().replaceAll("-", "").slice(0, 22);
    khaltiPayments.set(pidx, {
      pidx,
      amount: body.amount,
      purchaseOrderId: body.purchase_order_id,
      purchaseOrderName: body.purchase_order_name,
      returnUrl: body.return_url,
      status: "Initiated",
      transactionId: null,
    });
    res.json({
      pidx,
      payment_url: `${baseUrl}/khalti/pay/${pidx}`,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      expires_in: 3600,
    });
  });

  app.post("/khalti/epayment/lookup/", (req: Request, res: Response) => {
    if (!khaltiAuthorized(req, res)) return;
    const pidx = (req.body as { pidx?: unknown } | undefined)?.pidx;
    const payment = typeof pidx === "string" ? khaltiPayments.get(pidx) : undefined;
    if (!payment) {
      res.status(404).json({ detail: "Not found.", error_key: "validation_error" });
      return;
    }
    const failed = payment.status === "Expired" || payment.status === "User canceled";
    res.status(failed ? 400 : 200).json(khaltiLookupBody(payment));
  });

  app.get("/khalti/pay/:pidx", (req: Request<{ pidx: string }>, res: Response) => {
    const payment = khaltiPayments.get(req.params.pidx);
    if (!payment) {
      res.status(404).send(page("Khalti (test)", "<p>Unknown payment.</p>"));
      return;
    }
    const action = (path: string, label: string) =>
      `<form method="post" action="/khalti/${path}/${encodeURIComponent(payment.pidx)}"><button type="submit">${label}</button></form>`;
    res.send(
      page(
        "Khalti (test)",
        `<p>Pay ${escapeHtml(String(payment.amount))} paisa for ${escapeHtml(payment.purchaseOrderName)}</p>${action("pay", "Pay with test Khalti")}${action("cancel", "Cancel Khalti payment")}`,
      ),
    );
  });

  app.post("/khalti/pay/:pidx", (req: Request<{ pidx: string }>, res: Response) => {
    const payment = khaltiPayments.get(req.params.pidx);
    if (!payment) {
      res.status(404).send(page("Khalti (test)", "<p>Unknown payment.</p>"));
      return;
    }
    completeKhalti(payment.pidx);
    res.redirect(
      303,
      withQuery(payment.returnUrl, {
        pidx: payment.pidx,
        status: "Completed",
        transaction_id: payment.transactionId ?? "",
        amount: String(payment.amount),
        total_amount: String(payment.amount),
        purchase_order_id: payment.purchaseOrderId,
        purchase_order_name: payment.purchaseOrderName,
      }),
    );
  });

  app.post("/khalti/cancel/:pidx", (req: Request<{ pidx: string }>, res: Response) => {
    const payment = khaltiPayments.get(req.params.pidx);
    if (!payment) {
      res.status(404).send(page("Khalti (test)", "<p>Unknown payment.</p>"));
      return;
    }
    payment.status = "User canceled";
    res.redirect(
      303,
      withQuery(payment.returnUrl, {
        pidx: payment.pidx,
        status: "User canceled",
        purchase_order_id: payment.purchaseOrderId,
      }),
    );
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(options.port ?? 0, host, () => resolve(s));
    s.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

  return {
    baseUrl,
    esewaConfig: {
      productCode: keys.esewa.productCode,
      secretKey: keys.esewa.secretKey,
      formUrl: `${baseUrl}/esewa/form`,
      statusUrl: `${baseUrl}/esewa/status`,
    },
    khaltiConfig: { secretKey: keys.khalti.secretKey, apiUrl: `${baseUrl}/khalti` },
    esewa: { transactions: esewaTransactions, complete: completeEsewa, signedData },
    khalti: { payments: khaltiPayments, requests: khaltiRequests, complete: completeKhalti },
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Random keys for one test run (never real credentials). */
export function testGatewayKeys(): FakeGatewayKeys {
  return {
    esewa: { productCode: "EPAYTEST", secretKey: randomBytes(24).toString("base64") },
    khalti: { secretKey: `test_${randomBytes(16).toString("hex")}` },
  };
}
