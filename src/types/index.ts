export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  thinking: string | null;
  imageId: string | null;
  imageSize?: ImageSize | null;
  attachments?: AttachmentMeta[];
  model: string | null;
  createdAt: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  kind: "image" | "text" | "document";
  mimeType: string;
  size: number;
  tokens: number;
}

export type ImageSize = "square" | "portrait" | "landscape";

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  projectId: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
}

export interface AppSettings {
  defaultModel: string;
  theme: "dark" | "light" | "system";
  temperature: number;
  topP: number;
  numCtx: number;
  systemPrompt: string;
  fontSize: "sm" | "md" | "lg";
  compact: boolean;
}

export interface ModelInfo {
  name: string;
  vision: boolean;
  sizeBytes: number;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
}

export interface OllamaStatus {
  online: boolean;
  version?: string;
  loadedModels: { name: string; sizeVram: number; contextLength?: number; expiresAt?: string }[];
  error?: string;
}

export interface GenerationOptions {
  temperature?: number;
  topP?: number;
  numCtx?: number;
}

/** Events streamed from POST /api/chat, one JSON object per line. */
export type StreamEvent =
  | { type: "meta"; conversationId: string; userMessageId: string; title: string }
  | { type: "notice"; message: string }
  | { type: "thinking"; delta: string }
  | { type: "content"; delta: string }
  | { type: "done"; messageId: string; stats?: { tokens: number; seconds: number } }
  | { type: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "ollama_offline"
  | "model_missing"
  | "out_of_memory"
  | "context_too_large"
  | "generation_failed"
  | "image_unavailable"
  | "model_no_vision"
  | "attachment_error"
  | "bad_request";
