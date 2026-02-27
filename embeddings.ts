/**
 * OpenAI-compatible embedding service.
 * Reuses the same pattern as memory-lancedb.
 */

import OpenAI from "openai";

export class Embeddings {
  private client: OpenAI;
  private model: string;
  private dimensions?: number;

  constructor(apiKey: string, model: string, baseUrl?: string, dimensions?: number) {
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    });
    if (!response.data[0]) {
      throw new Error(
        `Embedding API returned empty data for model ${this.model}`,
      );
    }
    return response.data[0].embedding;
  }
}
