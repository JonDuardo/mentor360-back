require('dotenv').config(); // Carrega as variáveis do .env
const express = require('express'); // Framework do servidor
const cors = require('cors'); // Middleware CORS
const bcrypt = require('bcryptjs'); // Para hash de senha
const { createClient } = require('@supabase/supabase-js'); // Cliente Supabase
const { OpenAI } = require("openai"); // Adiciona a importação da OpenAI
const { taggearMensagem } = require("./tagger-utils"); // Adiciona sua função de tagging
const { buscarConteudoBasePorTags } = require('./conteudo_utils');


const app = express(); // Cria a aplicação Express

app.use(cors()); // Habilita CORS para todas as rotas
app.use(express.json()); // Permite receber JSON

// Configura a conexão com o Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// ================== ROTA DE CADASTRO ==================
app.post('/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;

  // 1. Validação básica
  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  }

  // 2. Verifica se e-mail já existe
  const { data: usuarios, error: errorSelect } = await supabase
    .from('usuarios')
    .select('*')
    .eq('email', email);

  if (errorSelect) {
    return res.status(500).json({ erro: 'Erro no banco de dados.' });
  }

  if (usuarios.length > 0) {
    return res.status(409).json({ erro: 'E-mail já cadastrado.' });
  }

  // 3. Gera o hash seguro da senha
  const senhaHash = await bcrypt.hash(senha, 10);

  // 4. Insere novo usuário
  const { error: errorInsert } = await supabase
    .from('usuarios')
    .insert([{ nome, email, senha_hash: senhaHash }]);

  if (errorInsert) {
    return res.status(500).json({ erro: 'Erro ao cadastrar usuário.' });
  }

  return res.status(201).json({ mensagem: 'Cadastro realizado com sucesso!' });
});

// ================== ROTA DE LOGIN ==================
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  }

  // Busca usuário pelo e-mail
  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('email', email);

  if (error) {
    return res.status(500).json({ erro: 'Erro no banco de dados.' });
  }
  if (!usuarios || usuarios.length === 0) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }

  const usuario = usuarios[0];

  // Valida senha digitada
  const senhaConfere = await bcrypt.compare(senha, usuario.senha_hash);
  if (!senhaConfere) {
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }

  // LOGIN OK! Retorne user_id e nome para o front
  return res.json({
    mensagem: `Login autorizado! Bem-vindo(a), ${usuario.nome}`,
    user_id: usuario.id,
    nome: usuario.nome
  });
});

// ==================ENDPOINT TESTE TAGGEAMENTO EM TEMPO REAL====================

app.post('/tag-teste', async (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem) return res.status(400).json({ erro: 'Envie a mensagem!' });

  try {
    const tagsTema = await taggearMensagem(openai, mensagem);
    return res.json({ tags: tagsTema });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao taggear', detalhes: error.message });
  }
});





//*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-nova sessão-*-*-*-*-*-*-*-*-*-*-*-*-*-*

// ================== ROTA DE NOVA SESSÃO/MENSAGEM ==================
app.post('/sessao', async (req, res) => {
  console.log('BODY recebido:', req.body);
  const { user_id, mensagem } = req.body; // Recebe user_id e mensagem do usuário

  if (!user_id || !mensagem) {
    return res.status(400).json({ erro: 'Informe user_id e mensagem.' });
  }

  // Data/hora atual
  const data_sessao = new Date().toISOString();

  // Para o MVP, resumo é igual à mensagem; status começa como 'aberta'
  const resumo = mensagem;
  const status = 'aberta';

  // Tags e sentimentos ainda vazios (pode evoluir depois!)
  const tags_tema = [];
  const tags_risco = [];
  const sentimentos_reportados = "";

  // Salva a nova sessão no banco
  const { data, error } = await supabase
    .from('sessoes')
    .insert([
      {
        user_id,
        data_sessao,
        resumo,
        status,
        pendencias: "",
        tags_tema,
        tags_risco,
        sentimentos_reportados
      }
    ])
    .select();

  if (error) {
    return res.status(500).json({ erro: 'Erro ao registrar sessão.' });
  }

  // Retorna o registro criado
  return res.status(201).json({
    mensagem: 'Sessão registrada com sucesso!',
    sessao: data[0]
  });
});







// =============== ROTA DE BUSCAR ÚLTIMAS SESSÕES DE UM USUÁRIO ===============
app.get('/sessoes/:user_id', async (req, res) => {
  const { user_id } = req.params;

  if (!user_id) {
    return res.status(400).json({ erro: 'Informe o user_id.' });
  }

  // Busca as 3 sessões mais recentes do usuário
  const { data, error } = await supabase
    .from('sessoes')
    .select('id, data_sessao, resumo, tags_tema, tags_risco, sentimentos_reportados, status')
    .eq('user_id', user_id)
    .order('data_sessao', { ascending: false });
    
  if (error) {
    return res.status(500).json({ erro: 'Erro ao buscar sessões.' });
  }

  return res.json({ sessoes: data });
});







// Função aprimorada para montar o contexto do usuário antes de chamar a IA
async function montarContextoCompleto(user_id) {
  // 1. Buscar perfil permanente
  const { data: perfil } = await supabase
    .from('perfil_psicologico')
    .select('tracos_personalidade, valores_declarados, notas_mentor')
    .eq('user_id', user_id)
    .single();

  // 2. Buscar eventos de vida relevantes
  const { data: eventos } = await supabase
    .from('eventos_vida')
    .select('tipo_evento, descricao, data_evento')
    .eq('user_id', user_id)
    .order('data_evento', { ascending: false })
    .limit(3);

  // 3. Buscar vínculos importantes
  const { data: vinculos } = await supabase
    .from('vinculos_usuario')
    .select('tipo_vinculo, nome_real, apelidos_descricoes, marcador_emocional')
    .eq('user_id', user_id);

  // 4. Buscar últimas sessões
  const { data: sessoes } = await supabase
    .from('sessoes')
    .select('data_sessao, resumo, tags_tema, tags_risco')
    .eq('user_id', user_id)
    .order('data_sessao', { ascending: false })
    .limit(3);

  // 5. Montar perfil do usuário
  let contexto = '';
  contexto += `Perfil do Usuário:\n`;
  contexto += `- Traços de personalidade: ${perfil?.tracos_personalidade || 'não informado'}\n`;
  contexto += `- Valores declarados: ${perfil?.valores_declarados || 'não informado'}\n`;
  contexto += `- Notas do mentor: ${perfil?.notas_mentor || 'não informado'}\n`;

  if (eventos && eventos.length > 0) {
    contexto += `Eventos de Vida Relevantes:\n`;
    eventos.forEach(ev => {
      contexto += `- (${ev.data_evento}) ${ev.tipo_evento}: ${ev.descricao}\n`;
    });
  }

  if (vinculos && vinculos.length > 0) {
    contexto += `Vínculos Importantes:\n`;
    vinculos.forEach(v => {
      contexto += `- [${v.tipo_vinculo}] ${v.nome_real || v.apelidos_descricoes?.join('/') || 'Desconhecido'} (Emoção: ${v.marcador_emocional?.join(', ') || 'não informado'})\n`;
    });
  }

  // 6. Montar resumo das últimas sessões
  contexto += `Últimas sessões:\n`;
  sessoes?.forEach(sessao => {
    contexto += `- ${new Date(sessao.data_sessao).toLocaleDateString()}: "${sessao.resumo}" | Temas: ${sessao.tags_tema?.join(', ') || '-'} | Riscos: ${sessao.tags_risco?.join(', ') || '-'}\n`;
  });

  return contexto;
}






// =============== ROTA DE TESTE: Buscar contexto completo do usuário ===============
app.get('/contexto/:user_id', async (req, res) => {
  const { user_id } = req.params;

  if (!user_id) {
    return res.status(400).json({ erro: 'Informe o user_id.' });
  }

  try {
    const contexto = await montarContextoCompleto(user_id);
    return res.json({ contexto });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao montar contexto.' });
  }
});



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


// =============== ROTA DE INTEGRAÇÃO COM GPT/OPENAI (AlanBot) ===============
app.post('/ia', async (req, res) => {
  const { user_id, sessao_id, mensagem } = req.body;
  if (!user_id || !sessao_id || !mensagem) {
    return res.status(400).json({ erro: 'Informe user_id, sessao_id e mensagem.' });
  }

// Tagging em tempo real
  const tagsTema = await taggearMensagem(openai, mensagem);
  console.log("Tags em tempo real para esta mensagem:", tagsTema);

// Busca o conteúdo do Alan de acordo com as tags detectadas
const conteudosBase = await buscarConteudoBasePorTags(supabase, tagsTema);

let contextoAlan = "";
if (conteudosBase && conteudosBase.length > 0) {
  contextoAlan = "Referências diretas do Alan para os temas detectados nesta mensagem:\n";
  conteudosBase.forEach(item => {
    contextoAlan += `\nTema: ${item.tema}\n`;
    contextoAlan += `Conceito: ${item.conceito}\n`;
    contextoAlan += `Ferramentas/Exercícios: ${item.ferramentas_exercicios}\n`;
    contextoAlan += `Frases/Citações: ${item.frases_citacoes}\n`;
  });
} else {
  contextoAlan = "Nenhuma referência específica do Alan encontrada para os temas detectados.\n";
}

console.log(contextoAlan);


// ---------- HISTÓRICO RECENTE (20 do usuário + 3 do bot) ----------
const { data: historicoUsuario, error: errorUsuario } = await supabase
  .from('mensagens_sessao')
  .select('texto_mensagem, origem, data_mensagem')
  .eq('sessao_id', sessao_id)
  .eq('origem', 'usuario')
  .order('data_mensagem', { ascending: false })
  .limit(20);

// ATENÇÃO: aqui é 'bot', igual você salva no banco
const { data: historicoBot, error: errorBot } = await supabase
  .from('mensagens_sessao')
  .select('texto_mensagem, origem, data_mensagem')
  .eq('sessao_id', sessao_id)
  .eq('origem', 'bot')
  .order('data_mensagem', { ascending: false })
  .limit(3);

if (errorUsuario || errorBot) {
  return res.status(500).json({ erro: 'Erro ao buscar histórico da sessão.' });
}

// Junta e ordena cronologicamente (do mais antigo para o mais novo)
let contextoConversa = '';
const combinado = [...(historicoUsuario || []), ...(historicoBot || [])]
  .sort((a, b) => new Date(a.data_mensagem) - new Date(b.data_mensagem));

if (combinado.length > 0) {
  contextoConversa = 'Histórico recente da conversa:\n';
  combinado.forEach(msg => {
    contextoConversa += `${msg.origem === 'usuario' ? 'Usuário' : 'Bot'}: ${msg.texto_mensagem}\n`;
  });
}
  // Buscar memórias relevantes usando embedding
  const memoriasRelevantes = await buscarResumosSemelhantes(supabase, openai, user_id, mensagem, 3);

  let contextoMemorias = "Memórias relevantes do histórico:\n";
  memoriasRelevantes.forEach(mem => {
    contextoMemorias += `- ${mem.resumo}\n`;
  });



  // 1. Montar o contexto do usuário
  const contexto = await montarContextoCompleto(user_id);

  // 2. Prompt sofisticado do AlanBot (exatamente como você enviou, adaptado para template literal)
  const prompt = `
1. Função Essencial
Você é a versão virtual do Alan Fernandes, mentor de autoconhecimento. Sua missão é guiar pessoas no desenvolvimento de habilidades e estratégias mentais, emocionais e comportamentais, ajudando-as a reconhecer e transformar estratégias inconscientes de vida em escolhas conscientes e intencionais.

2. Estilo de Comunicação
Use uma linguagem informal, acolhedora, instrutiva, provocadora e firme.

Adapte-se ao nível de instrução do usuário, do simples ao sofisticado.

Seja cordial, educado e acolhedor, sem bajulação nem validação excessiva.

Ajude o usuário a se questionar com clareza e profundidade, usando perguntas reflexivas, exemplos práticos, metáforas e provocações.

Nunca sobrecarregue o usuário com muita informação. A cada início de conversa comece fazendo perguntas que te dêem uma noção melhor sobre o que o cliente quer falar. Não saia fazendo perguntas aleatórias sobre o tema. Quando for fazer perguntas de aproveitamento faça 1 de cada vez. Da mesma forma, se for sugerir algum exercício, dê no máximo 2 opções.

Respeite sempre o ritmo e o estágio de desenvolvimento de cada pessoa.

2A. Referência ao Alan real — Autoridade e Citações
Sempre que cabível, utilize citações ou parafraseamentos de falas do Alan, ou referências explícitas ao que ele ensina em seus cursos, livros ou palestras. Use as falas do Alan real como se fossem suas. Não exagere na quantidade de citações para não ficar cansativo. Pense em uma citação a cada 5 respostas, no máximo.

Crie situações como:

“Nos meus cursos e palestras eu sempre digo que...” (e continue com falas do Alan real)

“Nessas situações eu sempre digo que...” (e continue com falas do Alan real)

O objetivo é, além de acolher e ajudar o usuário, reforçar a autoridade, experiência e assinatura única do Alan.

3. Base de Conhecimento
Priorize sempre os materiais autorais do criador deste GPT (transcrições, livros, apostilas, etc).

Como complemento, use conteúdos de autores consagrados da psicologia, psicanálise, neurociência, coaching, filosofia e espiritualidade, citando sempre autor e obra ao usar conceitos diretos.

Nunca utilize conhecimento genérico, inventado ou sem referência.

Autores Referenciáveis (citar ao usar conceitos):
Carl Jung, James Hollis, Gabor Maté, Stephen Gilligan & Robert Dilts, Byron Katie, Ken Wilber, Marshall Rosenberg, Jordan Peterson, Brené Brown, Donald Kalsched, Michael White & David Epston, António Damásio, Lisa Feldman Barrett, Alain de Botton, Esther Perel.

4. Orientações Éticas e de Postura
Nunca tome decisões nem diga o que alguém deve ou não fazer.

Nunca dê diagnósticos nem use rótulos clínicos.

Não tente resolver o problema sozinho nem sugira soluções mágicas.

Sua função é provocar reflexões, iluminar padrões e abrir caminhos de escolha.

Respeite o tempo de maturação de cada pessoa.

Jamais invente ou alucine informações.

5. Fluxo Geral de Atendimento
A) Atendimento Geral (sem risco agudo)
Escute ativamente, sem julgamentos.

Use perguntas abertas e reflexivas.

Promova o autoconhecimento pelo questionamento e exemplos práticos.

Adapte-se ao ritmo e necessidade do usuário.

Cite autores, fontes ou falas do Alan sempre que pertinente.

B) Atendimento em Situações de Risco Psíquico Grave
(Ex: ideação suicida, menção de violência doméstica, risco iminente)

Diretrizes Principais
Nunca minimizar ou ignorar relatos de sofrimento intenso, ideação suicida ou violência.

Nunca insista excessivamente nem repita de modo robotizado.

Adapte o tom conforme as respostas do usuário, validando resistências (medo, vergonha, descrença).

Deixe claro que não substitui ajuda profissional e que o usuário não precisa enfrentar nada sozinho.

Priorize sempre a busca de apoio humano especializado.

Interrompa a abordagem habitual de autoconhecimento nessas situações.

Procedimentos Recomendados
Primeiro acolhimento:

Escute ativamente, sem julgamento.

Reconheça a legitimidade da dor e do sofrimento.

Encaminhamento flexível:

Explique a importância da ajuda especializada.

Reconheça as dificuldades emocionais do usuário para buscar essa ajuda.

Ofereça micro-passos: compartilhar com alguém de confiança, buscar grupos de apoio, pensar em procurar um profissional quando se sentir pronto.

Varie as formas de sugerir apoio, evitando repetir o mesmo conselho.

Humanize: mostre compreensão sobre as dificuldades de se abrir.

Perguntas reflexivas:

Pergunte: “O que mais pesa agora?”, “O que te impede de pedir ajuda?”, “O que seria um alívio hoje?”

Convide a imaginar pequenos cenários de mudança, sem pressionar.

Segurança acima de tudo:

Se houver risco iminente (ameaça à vida ou violência física), reforce a importância do auxílio imediato (emergência, pessoas de confiança).

Nunca incentive o isolamento na crise.

Se o usuário recusar ajuda, siga acolhendo e ouvindo, deixando sempre a porta aberta para a busca de apoio especializado.

Encerramento cuidadoso:

Agradeça a confiança.

Reforce que pedir ajuda é um ato de coragem, não fraqueza.

Nunca deixe de mencionar, mesmo que sutilmente, o valor do apoio humano especializado.

Exemplo de frases/linguagem adequada
“Eu entendo que pode ser muito difícil confiar em alguém ou buscar ajuda quando a dor é tão grande. Se preferir, a gente pode só conversar aqui por enquanto. Quando e se sentir vontade, vale tentar buscar um apoio especializado, porque você merece esse cuidado.”

“Não tenho como substituir o suporte de um profissional, mas posso te escutar e caminhar junto até você se sentir mais pronto pra dar esse passo.”

“Se sentir vontade de conversar com alguém presencialmente, pode ser até um amigo, familiar ou alguém da sua confiança. Você não precisa fazer tudo sozinho.”

“Nos meus cursos costumo dizer que pedir ajuda é um ato de coragem e maturidade — não um sinal de fraqueza.”

Importante: Sempre acolher com humanidade e flexibilidade, sem abrir mão do compromisso ético de orientar sobre a busca de ajuda especializada quando necessário.

Resumo:
Você deve conduzir o processo de autoconhecimento com profundidade, referência teórica, acolhimento e provocações, e interromper imediatamente essa abordagem diante de sofrimento psíquico grave, priorizando acolhimento, flexibilidade e encaminhamento responsável, com tom sempre humano, nunca robotizado.
Cite sempre que possível falas ou ensinamentos do Alan, reforçando sua autoridade e assinatura pessoal no processo.

-------------------------------

CONTEXTO CONTEÚDO BASE
${contextoAlan}

HISTÓRICO DA CONVERSA:
${contextoConversa}

MEMÓRIAS RELEVANTES:
${contextoMemorias}

MENSAGEM DO USUÁRIO:
"${mensagem}"
`;

  // 3. Chamar o GPT-4.x
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // ou "gpt-4.0", "gpt-4.1" se sua conta permitir
      messages: [{ role: "system", content: prompt }]
    });
    const resposta = completion.choices[0].message.content;

// Salva a resposta do bot como mensagem da sessão (origem: "bot")
await supabase
  .from('mensagens_sessao')
  .insert([
    {
      sessao_id: sessao_id,
      user_id: user_id,
      texto_mensagem: resposta,
      origem: "bot"
    }
  ]);

return res.json({ resposta });

  } catch (error) {
    console.error('Erro GPT:', error);
    return res.status(500).json({ erro: 'Erro ao gerar resposta da IA.' });
  }
});






// Endpoint para salvar mensagem individual da sessão no banco
app.post('/mensagem', async (req, res) => { // Rota POST /mensagem

  const { sessao_id, user_id, texto_mensagem, origem } = req.body; // Extrai os dados enviados

  // Checa se campos obrigatórios foram enviados
  if (!sessao_id || !user_id || !texto_mensagem) {
    return res.status(400).json({ error: "Campos obrigatórios faltando" });
  }

  try {
    const { data, error } = await supabase
      .from('mensagens_sessao') // Nome da tabela nova no Supabase
      .insert([
        {
          sessao_id,                // ID da sessão
          user_id,                  // ID do usuário (quem mandou)
          texto_mensagem,           // Mensagem de texto enviada
          origem: origem || "usuario" // Origem da mensagem: "usuario" (padrão), "bot", etc
        }
      ]);

    if (error) {
      throw error; // Se der erro ao salvar, lança erro para o catch
    }

    res.status(201).json({ success: true, mensagem: "Mensagem salva!", data }); // Sucesso: mensagem salva

  } catch (error) {
    res.status(500).json({ error: error.message }); // Erro no servidor
  }
});






// Endpoint para buscar o histórico de mensagens de uma sessão
app.get('/historico/:sessao_id', async (req, res) => { // Rota GET /historico/:sessao_id

  const { sessao_id } = req.params; // Pega o ID da sessão da URL

  try {
    const { data, error } = await supabase
      .from('mensagens_sessao')
      .select('*')
      .eq('sessao_id', sessao_id) // Filtra pelo ID da sessão
      .order('data_mensagem', { ascending: true }); // Ordena do mais antigo para o mais recente

    if (error) {
      throw error;
    }

    res.status(200).json({ mensagens: data }); // Retorna as mensagens no formato JSON

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});








app.post('/finalizar-sessao', async (req, res) => {
  const { sessao_id } = req.body;

  if (!sessao_id) {
    return res.status(400).json({ error: "sessao_id obrigatório" });
  }

  try {
    // 1. Buscar todas as mensagens da sessão
    const { data: mensagens, error } = await supabase
      .from('mensagens_sessao')
      .select('*')
      .eq('sessao_id', sessao_id)
      .order('data_mensagem', { ascending: true });

    if (error) throw error;
    if (!mensagens.length) return res.status(404).json({ error: "Sessão não encontrada ou sem mensagens" });

    // 2. Concatenar as mensagens em um texto só
    const textoSessao = mensagens.map(msg =>
      (msg.origem === "usuario" ? "Usuário: " : "Bot: ") + msg.texto_mensagem
    ).join('\n');

    // 3. Montar prompt do GPT (substitua as listas pelas suas listas reais!)
    const listaTagsTema = [
  "ansiedade e medo do futuro",
  "autoconfianca e coragem para mundancas",
  "autoconhecimento",
  "autoestima e autovalor",
  "autosabotagem e procrastinacao",
  "carreira e prosperidade",
  "carreira trabalho e prosperidade",
  "comunicacao e assertividade",
  "conflitos conjugais / amorosos",
  "culpa perdao e reconciliacao",
  "dependencia emocional",
  "espiritualidade e conexao emocional",
  "espiritualidade e conexao existencial",
  "limites autonomia e assertividade",
  "luto perdas e recomecos",
  "medo ansiedade e gestao de emocoes dificeis",
  "mudancas adaptacao e ciclos de vida",
  "procrastinacao e gestao de tempo",
  "proposito e sentido de vida",
  "proposito realizacao e construcao de futuro",
  "relacionamentos familiares",
  "saude emocional e autocuidado",
  "saude fisica autocuidado e corpo como aliado (saude cem)",
  "sexualidade e autoaceitacao do prazer",
  "traumas e feridas emocionais",
  "vergonha medo de exposicao e aceitacao social",
  "vulnerabilidade vergonha e autenticidade"
];
    const listaTagsRisco = [
  "ideacao_suicida",
  "autolesao",
  "violencia_domestica_(sofrida_ou_praticada)",
  "violencia_sexual",
  "abuso_fisico_ou_psicologico",
  "isolamento_extremo",
  "desamparo_total_(sentimento_de_abandono,desesperanca_intensa)",
  "ataques_de_panico_recorrentes",
  "crise_psicotica/agitacao_grave",
  "dependencia_quimica_ativa(com_risco_de_vida)",
  "recusa_total_de_ajuda_diante_de_sofrimento_grave"
];
    const prompt = `
Você é um mentor virtual. Analise o texto da sessão a seguir e faça:

1. Escreva um resumo objetivo dos principais pontos da sessão com no máximo 750 palavras. Esse resumo deve conter: pergunta ou dilema central; transcrições literais das mensagens do usuário ignorando respostas do GPT, com comentários sobre as mensagens; Sintese da seção; compromissos e perguntas abertas.
2. Liste os temas abordados, escolhendo apenas 2 entre as seguintes opções (tags de tema): ${listaTagsTema}
3. Liste os riscos detectados, escolhendo apenas entre as seguintes opções (tags de risco): ${listaTagsRisco}

A sessão do usuário foi:
""" 
${textoSessao}
"""

Retorne a resposta no seguinte formato JSON:
{
  "resumo": "...",
  "tags_tema": ["autoconhecimento", "ansiedade"],
  "tags_risco": ["ideacao_suicida"]
}
`;

    // 4. Chamar a API do GPT
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // ou "gpt-4.0", "gpt-3.5-turbo", conforme seu plano
      messages: [
        { role: "system", content: "Você é um mentor virtual especialista em psicologia e autoconhecimento." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 600
    });

   
// 5. Extrair JSON da resposta do GPT
let gptResposta;
let conteudo = completion.choices[0].message.content;

// Limpa crases e "json" do início/fim, se vier como bloco de código
conteudo = conteudo
  .replace(/^```json\s*/i, '') // remove ```json do início
  .replace(/^```/, '')         // remove ``` do início (se vier só crase)
  .replace(/```$/, '')         // remove ``` do fim
  .trim();                     // tira espaços extras

try {
  gptResposta = JSON.parse(conteudo);
} catch (err) {
  return res.status(500).json({ error: "Erro ao interpretar resposta do GPT", resposta_bruta: completion.choices[0].message.content });
}


    // 6. Atualizar a sessão no banco
    const { error: updateError } = await supabase
      .from('sessoes')
      .update({
        resumo: gptResposta.resumo,
        tags_tema: gptResposta.tags_tema,
        tags_risco: gptResposta.tags_risco,
        status: 'fechada'
      })
      .eq('id', sessao_id);

    if (updateError) throw updateError;

// GERA E GRAVA EMBEDDING DO RESUMO DA SESSÃO (após o update)
// 1. Chama a API OpenAI para gerar embedding do resumo da sessão
const embeddingResponse = await openai.embeddings.create({
  model: "text-embedding-3-small",      // Modelo de embedding (OpenAI)
  input: gptResposta.resumo             // O resumo gerado pelo GPT
});

// 2. Extrai o vetor de embedding (array de floats)
const embedding = embeddingResponse.data[0].embedding;

// 3. Busca user_id da sessão para gravar na tabela de embedding
const { data: sessaoInfo, error: sessaoError } = await supabase
  .from('sessoes')
  .select('user_id')
  .eq('id', sessao_id)
  .single();

if (sessaoError || !sessaoInfo) throw new Error('Sessão não encontrada para vincular user_id ao embedding');

// 4. Grava no Supabase (session_embeddings)
const { error: embError } = await supabase
  .from('session_embeddings')
  .insert([
    {
      user_id: sessaoInfo.user_id,      // user_id recuperado da sessão
      sessao_id: sessao_id,             // ID da sessão atual
      resumo: gptResposta.resumo,       // O resumo da sessão
      embedding: embedding              // O vetor de embedding
    }
  ]);

if (embError) throw embError;
// -- Fim da gravação de embedding --


    // 7. Retorna para o frontend o resumo e tags
    res.status(200).json({ sucesso: true, ...gptResposta });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});
