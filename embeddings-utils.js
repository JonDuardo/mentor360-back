// embeddings-utils.js
async function buscarResumosSemelhantes(supabase, openai, user_id, textoConsulta, nResultados = 3) {
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: textoConsulta
  });
  const novoEmbedding = embeddingResponse.data[0].embedding;
  const { data, error } = await supabase
    .rpc('buscar_resumos_semelhantes', {
      uid: user_id,
      query_embedding: novoEmbedding,
      n: nResultados
    });
  if (error) {
    console.error('Erro na busca vetorial:', error);
    return [];
  }
  return data;
}
module.exports = { buscarResumosSemelhantes };
