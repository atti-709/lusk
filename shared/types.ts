export interface UploadResponse {
  success: boolean;
  sessionId: string;
  fileName: string;
  url: string;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

export interface ErrorResponse {
  success: false;
  error: string;
}
