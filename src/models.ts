// Optional Ollama embeddings only. Generation aliases belong in LiteLLM.
const EMBEDDING_ALIASES: Record<string, string> = {
  "text-embedding-ada-002": "nomic-embed-text",
  "text-embedding-3-small": "nomic-embed-text",
  "text-embedding-3-large": "nomic-embed-text",
};
export function resolveModel(requested: string): string {
  return EMBEDDING_ALIASES[requested] || requested;
}
