export interface Chunk {
  readonly id: string;
  readonly text: string;
}

export interface Retriever {
  retrieve(creatorId: string, query: string, k: number): Promise<readonly Chunk[]>;
}
