export type OemerBridgeSuccess = {
  ok: true;
  musicXml: string;
  musicXmlPath?: string;
  logs: string[];
};

export type OemerBridgeFailure = {
  ok: false;
  code: string;
  message: string;
  logs: string[];
  details?: unknown;
};

export type OemerBridgeResult = OemerBridgeSuccess | OemerBridgeFailure;

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765/oemer/run';

export async function runOemerBridge(
  images: File[],
  endpoint = DEFAULT_ENDPOINT
): Promise<OemerBridgeResult> {
  const formData = new FormData();
  for (const image of images) {
    formData.append('images', image, image.name);
  }

  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', body: formData });
  } catch (error) {
    return {
      ok: false,
      code: 'bridge-unreachable',
      message: 'Could not reach local OEMER helper service at 127.0.0.1:8765.',
      logs: [],
      details: error instanceof Error ? error.message : String(error),
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      code: 'invalid-response',
      message: 'OEMER helper returned a non-JSON response.',
      logs: [],
    };
  }

  if (!response.ok) {
    const errorPayload = payload as Record<string, unknown>;
    return {
      ok: false,
      code: String(errorPayload.code ?? 'oemer-failed'),
      message: String(errorPayload.message ?? `OEMER failed with HTTP ${response.status}.`),
      logs: Array.isArray(errorPayload.logs) ? errorPayload.logs.map(String) : [],
      details: errorPayload.details,
    };
  }

  const successPayload = payload as Record<string, unknown>;
  if (typeof successPayload.music_xml !== 'string') {
    return {
      ok: false,
      code: 'missing-musicxml',
      message: 'OEMER helper succeeded but did not return music_xml.',
      logs: Array.isArray(successPayload.logs) ? successPayload.logs.map(String) : [],
    };
  }

  return {
    ok: true,
    musicXml: successPayload.music_xml,
    musicXmlPath:
      typeof successPayload.music_xml_path === 'string' ? successPayload.music_xml_path : undefined,
    logs: Array.isArray(successPayload.logs) ? successPayload.logs.map(String) : [],
  };
}
