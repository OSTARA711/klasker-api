// ~/klasker-api/src/index.ts

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    /*
     * Ably authentication endpoint.
     *
     * The browser supplies an analysis ID and receives a short-lived
     * TokenRequest restricted to that analysis channel.
     *
     * This uses the dedicated browser Subscribe-only Ably key.
     * The Worker publish key remains separate.
     */
    if (url.pathname === "/api/ably-auth" && request.method === "GET") {
      const analysisId = url.searchParams.get("analysis_id");

      if (!analysisId) {
        return Response.json(
          { error: "An analysis ID is required." },
          {
            status: 400,
            headers: corsHeaders(),
          },
        );
      }

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          analysisId,
        )
      ) {
        return Response.json(
          { error: "Invalid analysis ID." },
          {
            status: 400,
            headers: corsHeaders(),
          },
        );
      }

      try {
        const tokenRequest = await createAblyTokenRequest(
          env.ABLY_BROWSER_API_KEY,
          `klasker:analysis:${analysisId}`,
        );

        return Response.json(
          tokenRequest,
          {
            status: 200,
            headers: {
              ...corsHeaders(),
              "Cache-Control": "no-store",
            },
          },
        );
      } catch (error) {
        console.error("Ably authentication failed:", error);

        return Response.json(
          { error: "Unable to authenticate with Ably." },
          {
            status: 500,
            headers: corsHeaders(),
          },
        );
      }
    }

    /*
     * CORS preflight for browser requests to the API.
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (url.pathname !== "/api/analysis" || request.method !== "POST") {
      return Response.json(
        { error: "Not found." },
        {
          status: 404,
          headers: corsHeaders(),
        },
      );
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON." },
        {
          status: 400,
          headers: corsHeaders(),
        },
      );
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !("url" in body) ||
      typeof body.url !== "string"
    ) {
      return Response.json(
        { error: "A URL is required." },
        {
          status: 400,
          headers: corsHeaders(),
        },
      );
    }

    if (
      !("analysis_id" in body) ||
      typeof body.analysis_id !== "string"
    ) {
      return Response.json(
        { error: "An analysis ID is required." },
        {
          status: 400,
          headers: corsHeaders(),
        },
      );
    }

    const analysisId = body.analysis_id;

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        analysisId,
      )
    ) {
      return Response.json(
        { error: "Invalid analysis ID." },
        {
          status: 400,
          headers: corsHeaders(),
        },
      );
    }

    let target: URL;

    try {
      target = new URL(body.url);
    } catch {
      return Response.json(
        { error: "Invalid URL." },
        {
          status: 400,
          headers: corsHeaders(),
        },
      );
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return Response.json(
        { error: "Only HTTP and HTTPS URLs are supported." },
        {
          status: 400,
          headers: corsHeaders(),
        },
      );
    }

    const channel = `klasker:analysis:${analysisId}`;

    /*
     * Ably is deliberately best-effort at this stage.
     * A temporary Ably failure must not prevent the analysis
     * from being dispatched to a scanner.
     *
     * This uses the dedicated Worker Publish key.
     */
    await publishAbly(
      env.ABLY_API_KEY,
      channel,
      "accepted",
      {
        analysis_id: analysisId,
        status: "accepted",
        url: target.toString(),
      },
    );

    const scanners = [
      env.SCANNER_URL1,
      env.SCANNER_URL2,
    ];

    const requestBody = JSON.stringify({
      url: target.toString(),
    });

    /*
     * The scanner work continues independently of the HTTP
     * request. The client receives 202 immediately.
     */
    ctx.waitUntil(
      runAnalysis(
        env,
        analysisId,
        channel,
        scanners,
        requestBody,
      ),
    );

    return Response.json(
      {
        analysis_id: analysisId,
        status: "accepted",
      },
      {
        status: 202,
        headers: {
          ...corsHeaders(),
          "Cache-Control": "no-store",
        },
      },
    );
  },
};

async function createAblyTokenRequest(
  apiKey: string,
  channel: string,
): Promise<{
  keyName: string;
  ttl: number;
  capability: string;
  timestamp: number;
  nonce: string;
  mac: string;
}> {
  const separator = apiKey.indexOf(":");

  if (separator === -1) {
    throw new Error("Invalid Ably API key format.");
  }

  const keyName = apiKey.slice(0, separator);
  const keySecret = apiKey.slice(separator + 1);

  if (!keyName || !keySecret) {
    throw new Error("Invalid Ably API key.");
  }

  // Five minutes is more than enough for the browser to establish
  // the realtime connection while keeping the token short-lived.
  const ttl = 5 * 60 * 1000;

  const timestamp = Date.now();

  const random = new Uint8Array(24);
  crypto.getRandomValues(random);

  const nonce = bytesToBase64Url(random);

  /*
   * The browser only needs to receive messages from this particular
   * analysis channel. It must not be able to publish or access other
   * channels with this token.
   */
  const capability = JSON.stringify({
    [channel]: ["subscribe"],
  });

  /*
   * Ably requires these fields in this exact order, each followed
   * by a newline:
   *
   * keyName
   * ttl
   * capability
   * clientId
   * timestamp
   * nonce
   */
  const canonical = [
    keyName,
    String(ttl),
    capability,
    "",
    String(timestamp),
    nonce,
  ].join("\n") + "\n";

  const encoder = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keySecret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(canonical),
  );

  const mac = bytesToBase64(new Uint8Array(signature));

  return {
    keyName,
    ttl,
    capability,
    timestamp,
    nonce,
    mac,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "https://www.klasker.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function runAnalysis(
  env: Env,
  analysisId: string,
  channel: string,
  scanners: string[],
  requestBody: string,
): Promise<void> {
  // Randomly select a scanner for each request.
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);

  const primaryIndex = random[0] % scanners.length;
  const secondaryIndex = 1 - primaryIndex;

  const primary = scanners[primaryIndex];
  const secondary = scanners[secondaryIndex];

  let scannerResponse: Response | null = null;
  let selectedScanner = primary;

  // Try the randomly selected scanner first.
  try {
    scannerResponse = await fetch(
      `${primary}/scan`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.KLASKER_SCANNER_SECRET}`,
        },
        body: requestBody,
      },
    );
  } catch (error) {
    console.error("scanner request failed", {
      analysisId,
      scanner: primary,
      error,
    });

    scannerResponse = null;
  }

  // If the primary scanner failed, use the other scanner.
  if (!scannerResponse || !scannerResponse.ok) {
    selectedScanner = secondary;

    try {
      scannerResponse = await fetch(
        `${secondary}/scan`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.KLASKER_SCANNER_SECRET}`,
          },
          body: requestBody,
        },
      );
    } catch (error) {
      console.error("scanner request failed", {
        analysisId,
        scanner: secondary,
        error,
      });

      scannerResponse = null;
    }
  }

  // Both scanners could not be reached.
  if (!scannerResponse) {
    await publishAbly(
      env.ABLY_API_KEY,
      channel,
      "failed",
      {
        analysis_id: analysisId,
        status: "failed",
        error: "Unable to reach either scanner.",
      },
    );

    return;
  }

  // Both scanner attempts returned an unsuccessful HTTP status.
  if (!scannerResponse.ok) {
    await publishAbly(
      env.ABLY_API_KEY,
      channel,
      "failed",
      {
        analysis_id: analysisId,
        status: "failed",
        error: "Both scanner attempts failed.",
        scanner_status: scannerResponse.status,
      },
    );

    return;
  }

  const scannerBody = await scannerResponse.text();

  let result: unknown;

  try {
    result = JSON.parse(scannerBody);
  } catch {
    await publishAbly(
      env.ABLY_API_KEY,
      channel,
      "failed",
      {
        analysis_id: analysisId,
        status: "failed",
        error: "Scanner returned invalid JSON.",
      },
    );

    return;
  }

  // Scanner completed successfully.
  await publishAbly(
    env.ABLY_API_KEY,
    channel,
    "completed",
    {
      analysis_id: analysisId,
      status: "completed",
      scanner: selectedScanner,
      result,
    },
  );
}

async function publishAbly(
  apiKey: string,
  channel: string,
  eventName: string,
  data: unknown,
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://main.realtime.ably.net/channels/${encodeURIComponent(channel)}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa(apiKey)}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          name: eventName,
          data,
        }),
      },
    );

    if (!response.ok) {
      console.error(
        `Ably publish failed: ${response.status} ${response.statusText}`,
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error("Ably publish failed:", error);
    return false;
  }
}
