// conteudo_utils.js

async function buscarConteudoBasePorTags(supabase, tags) {
  if (!tags || tags.length === 0) return [];

  const { data, error } = await supabase
    .from('conteudo_base')
    .select('tema, conceito, ferramentas_exercicios, frases_citacoes')
    .in('tema', tags);

  if (error) {
    console.error('Erro ao buscar conteudo_base:', error);
    return [];
  }
  return data; // [{tema, conceito, ferramentas_exercicios, frases_citacoes}]
}

module.exports = { buscarConteudoBasePorTags };
