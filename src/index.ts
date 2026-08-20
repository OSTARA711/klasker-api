// ~/klasker-api/src/index.ts

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/api/analysis" || request.method !== "POST") {
      return Response.json(
        { error: "Not found." },
        { status: 404 },
      );
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON." },
        { status: 400 },
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
        { status: 400 },
      );
    }

    let target: URL;

    try {
      target = new URL(body.url);
    } catch {
      return Response.json(
        { error: "Invalid URL." },
        { status: 400 },
      );
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return Response.json(
        { error: "Only HTTP and HTTPS URLs are supported." },
        { status: 400 },
      );
    }

    const analysisId = crypto.randomUUID();
    const channel = `klasker:analysis:${analysisId}`;

    // Ably is deliberately best-effort at this stage.
    // A temporary Ably failure must not break the scanner.
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

    // Randomly select a scanner for each request.
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);

    const primaryIndex = random[0] % scanners.length;
    const secondaryIndex = 1 - primaryIndex;

    const primary = scanners[primaryIndex];
    const secondary = scanners[secondaryIndex];

    const requestBody = JSON.stringify({
      url: target.toString(),
    });

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
    } catch {
      scannerResponse = null;
    }

    // If it failed, use the other scanner.
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
      } catch {
        scannerResponse = null;
      }
    }

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

      return Response.json(
        {
          analysis_id: analysisId,
          error: "Unable to reach either scanner.",
        },
        { status: 502 },
      );
    }

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

      return Response.json(
        {
          analysis_id: analysisId,
          error: "Both scanner attempts failed.",
          status: scannerResponse.status,
        },
        { status: 502 },
      );
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

      return Response.json(
        {
          analysis_id: analysisId,
          error: "Scanner returned invalid JSON.",
        },
        { status: 502 },
      );
    }

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

    return new Response(
      JSON.stringify({
        analysis_id: analysisId,
        status: "completed",
        result,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Klasker-Scanner": selectedScanner,
        },
      },
    );
  },
};

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
    console.error("Ably publish error:", error);
    return false;
  }
}

interface Env {
  ABLY_API_KEY: string;
  KLASKER_SCANNER_SECRET: string;
  SCANNER_URL1: string;
  SCANNER_URL2: string;
}
