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
      return Response.json(
        { error: "Unable to reach either scanner." },
        { status: 502 },
      );
    }

    if (!scannerResponse.ok) {
      return Response.json(
        {
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
      return Response.json(
        { error: "Scanner returned invalid JSON." },
        { status: 502 },
      );
    }

    return new Response(
      JSON.stringify(result),
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

interface Env {
  KLASKER_SCANNER_SECRET: string;
  SCANNER_URL1: string;
  SCANNER_URL2: string;
}
