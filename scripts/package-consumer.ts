import {
  createCailClient,
  type CailChatRequest,
} from "@cuny-ai-lab/cail-client";
import { quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";

const client = createCailClient({ app: "package-consumer" });
const request: CailChatRequest = { model: "test-model", messages: [] };
const response: Promise<Response> = client.chatCompletions(request, "test-key");
const code: string = quotaExceededEnvelope().error.code;
void response;
void code;
