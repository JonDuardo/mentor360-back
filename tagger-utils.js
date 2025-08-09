// tagger-utils.js

async function taggearMensagem(openai, mensagem) {
  const listaTagsTema = "[autoconhecimento, autoestima e autovalor, autossabotagem e procrastinação, relacionamentos familiares, conflitos conjugais / amorosos, luto e perdas, mudanças de vida e transições, ansiedade e medo do futuro, propósito e sentido de vida, vulnerabilidade, vergonha e autenticidade, carreira e prosperidade (dinheiro, trabalho, empreendedorismo), saúde emocional e autocuidado, comunicação e assertividade, limites e autonomia, espiritualidade e conexão existencial, traumas e feridas emocionais, dependência emocional, padrões repetitivos (círculos viciosos), culpa e perdão, relacionamento com o corpo e autoimagem, sexualidade e intimidade, parentalidade (ser pai/mãe, educação de filhos), tomada de decisão e responsabilidade, crises existenciais, resiliência e superação, gratidão e abundância]";

  const taggingPrompt = `
Analise a mensagem abaixo e devolva APENAS as tags de tema (máximo 3) que melhor representam o assunto da fala, escolhendo entre a lista fornecida.  
Mensagem: "${mensagem}"
Tags disponíveis: ${listaTagsTema}

Responda apenas em JSON: { "tags_tema": ["..."] }
  `;

  const taggingCompletion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: taggingPrompt }],
    temperature: 0,
    max_tokens: 100,
  });

  let tags = [];
try {
  let content = taggingCompletion.choices[0].message.content;
  // Limpa crases e "json" do início/fim
  content = content
    .replace(/^```json\s*/i, '') // remove ```json do início
    .replace(/^```/, '')         // remove ``` do início (se vier só crase)
    .replace(/```$/, '')         // remove ``` do fim
    .trim();                     // tira espaços extras
  console.log("Conteúdo limpo:", content); // Novo log
  tags = JSON.parse(content).tags_tema;
} catch (err) {
  console.log("Erro ao interpretar resposta da OpenAI:", err);
  tags = [];
}
return tags; // <--- NÃO ESQUEÇA O RETURN!
}
module.exports = { taggearMensagem };
