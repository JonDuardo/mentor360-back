require('dotenv').config(); // Carrega as variáveis do .env
const express = require('express'); // Framework do servidor
const cors = require('cors'); // Middleware CORS
const bcrypt = require('bcryptjs'); // Para hash de senha
const { createClient } = require('@supabase/supabase-js'); // Cliente Supabase
const { OpenAI } = require('openai'); // OpenAI
const { taggearMensagem } = require('./tagger-utils'); // Tagging
const { buscarConteudoBasePorTags } = require('./conteudo_utils'); // Conteúdo autoral Alan

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------
// Supabase & OpenAI
// ---------------------------------------------------------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// (opcional) rota raiz simples p/ teste
app.get('/', (_req, res) => res.send('API Mentor 360 funcionando!'));

// ---------------------------------------------------------------------
// Utilitários locais
// ---------------------------------------------------------------------
function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}
function limitArr(arr, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(-n);
}
function safeParseJSON(str, fallback = null) {
  try {
    return JSON.parse(String(str || '').trim());
  } catch {
    return fallback;
  }
}

// Gera/atualiza um perfil compacto (curto) de uma pessoa.
// Regra: tenta usar GPT “mini” (barato). Se falhar, usa um resumo local.
async function gerarPerfilCompacto({ nome_real, tipo_vinculo, marcador_emocional = [], contextos_relevantes = [] }) {
  const localFallback = `${nome_real} — ${tipo_vinculo || 'vínculo'}; emoções: ${uniq(marcador_emocional).join(', ') || '—'}; contextos: ${limitArr(contextos_relevantes, 2).join(' / ') || '—'}`;
  try {
    const prompt = `
Resuma em NO MÁXIMO 2 frases, de forma objetiva e útil para um assistente conversacional, o vínculo abaixo.
Campos:
- Nome
- Tipo de vínculo
- Emoções predominantes (se houver)
- Contextos frequentes (se houver)
Produza uma só linha curta, sem títulos.

Dados:
${JSON.stringify({ nome_real, tipo_vinculo, marcador_emocional, contextos_relevantes })}
`;
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 120,
    });
    const txt = r.choices?.[0]?.message?.content?.trim();
    if (!txt) return localFallback;
    // remove eventuais crases/blocos
    return txt.replace(/^```.*\n?/g, '').replace(/```$/g, '').trim();
  } catch {
    return localFallback;
  }
}

// Detecta pessoas mencionadas na mensagem e atualiza/insere em vinculos_usuario.
// Retorna a lista de nomes/aliases detectados (para usarmos no contexto).
async function processarVinculosUsuario(mensagem, user_id) {
  try {
    const promptDeteccao = `
Analise a mensagem abaixo e retorne SOMENTE um JSON (array) com as pessoas mencionadas.
Formato:
[
  {
    "nome_real": "Nome da pessoa (se souber)",
    "apelidos_descricoes": ["apelido1","apelido2"],
    "tipo_vinculo": "ex.: esposa, amigo, mãe, chefe",
    "marcador_emocional": ["emoções principais, ex.: amor, raiva, culpa"],
    "contexto_relevante": "frase curta do contexto em que a pessoa foi citada"
  }
]
Se não houver pessoas, retorne [].
Mensagem:
"""${mensagem}"""
`;
    const det = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: promptDeteccao }],
      temperature: 0,
      max_tokens: 300,
    });

    let pessoasDetectadas = safeParseJSON(det.choices?.[0]?.message?.content, []);
    if (!Array.isArray(pessoasDetectadas)) pessoasDetectadas = [];

    if (pessoasDetectadas.length === 0) return [];

    // Carrega vínculos existentes do usuário para match por nome/alias em memória (mais flexível)
    const { data: existentesAll } = await supabase
      .from('vinculos_usuario')
      .select('*')
      .eq('user_id', user_id);

    const agoraISO = new Date().toISOString();
    const nomesOuApelidosMencionados = [];

    for (const pessoa of pessoasDetectadas) {
      const nome_real = (pessoa.nome_real || '').trim();
      const apelidos_descricoes = Array.isArray(pessoa.apelidos_descricoes)
        ? uniq(pessoa.apelidos_descricoes.map(s => String(s).trim()).filter(Boolean))
        : [];
      const tipo_vinculo = (pessoa.tipo_vinculo || '').trim();
      const marcador_emocional = Array.isArray(pessoa.marcador_emocional)
        ? uniq(pessoa.marcador_emocional.map(s => String(s).trim()).filter(Boolean))
        : [];
      const contexto_relevante = (pessoa.contexto_relevante || '').trim();

      // tenta achar match por nome_real ou por apelido
      let atual = null;
      if (existentesAll && existentesAll.length) {
        atual =
          existentesAll.find(v => v.nome_real?.toLowerCase() === nome_real.toLowerCase() && nome_real) ||
          existentesAll.find(v => {
            const aliases = Array.isArray(v.apelidos_descricoes) ? v.apelidos_descricoes.map(a => (a || '').toLowerCase()) : [];
            return apelidos_descricoes.some(a => aliases.includes(a.toLowerCase()));
          });
      }

      // Arrays que vamos atualizar
      const novoHistorico = [{ data: agoraISO, trecho: mensagem }];
      const novosContextos = contexto_relevante ? [contexto_relevante] : [];

      if (atual) {
        const historico = Array.isArray(atual.historico_mencoes) ? atual.historico_mencoes : [];
        const contextos = Array.isArray(atual.contextos_relevantes) ? atual.contextos_relevantes : [];
        const tags = Array.isArray(atual.tags_associadas) ? atual.tags_associadas : [];
        const emoc = Array.isArray(atual.marcador_emocional) ? atual.marcador_emocional : [];
        const aliases = Array.isArray(atual.apelidos_descricoes) ? atual.apelidos_descricoes : [];

        const atualizado = {
      ultima_mencao: agoraISO,
      frequencia_mencao: (atual.frequencia_mencao || 0) + 1,
      historico_mencoes: limitArr([...historico, ...novoHistorico], 5),
      contextos_relevantes: limitArr(uniq([...contextos, ...novosContextos]), 3),
      tags_associadas: uniq([...tags, tipo_vinculo].filter(Boolean)),
      marcador_emocional: uniq([...emoc, ...marcador_emocional]),
      apelidos_descricoes: uniq([...aliases, ...apelidos_descricoes].filter(Boolean)),
        };

        // Atualiza e, se mudar bastante, regera perfil_compacto
        let perfil_compacto = atual.perfil_compacto;
        const mudouMuito =
          atualizado.frequencia_mencao % 3 === 0 ||
          (atualizado.marcador_emocional.length || 0) > (emoc.length || 0) ||
          (atualizado.contextos_relevantes.length || 0) > (contextos.length || 0);

        if (mudouMuito) {
          perfil_compacto = await gerarPerfilCompacto({
            nome_real: atual.nome_real || nome_real || (apelidos_descricoes[0] || 'Pessoa'),
            tipo_vinculo: atual.tipo_vinculo || tipo_vinculo,
            marcador_emocional: atualizado.marcador_emocional,
            contextos_relevantes: atualizado.contextos_relevantes,
          });
          atualizado.perfil_compacto = perfil_compacto;
        }

        await supabase.from('vinculos_usuario').update(atualizado).eq('id', atual.id);
        nomesOuApelidosMencionados.push(nome_real || apelidos_descricoes[0] || atual.nome_real);
      } else {
        // Novo registro
        const inicial = {
          user_id,
          nome_real: nome_real || (apelidos_descricoes[0] || 'Pessoa'),
          apelidos_descricoes,
          tipo_vinculo,
          marcador_emocional,
          primeira_mencao: agoraISO,
          ultima_mencao: agoraISO,
          frequencia_mencao: 1,
          historico_mencoes: novoHistorico,
          contextos_relevantes: novosContextos,
          tags_associadas: uniq([tipo_vinculo].filter(Boolean)),
        };
        inicial.perfil_compacto = await gerarPerfilCompacto({
          nome_real: inicial.nome_real,
          tipo_vinculo: inicial.tipo_vinculo,
          marcador_emocional: inicial.marcador_emocional,
          contextos_relevantes: inicial.contextos_relevantes,
        });

        const { data: inserido } = await supabase.from('vinculos_usuario').insert([inicial]).select().limit(1);
        if (inserido && inserido[0]) {
          nomesOuApelidosMencionados.push(inserido[0].nome_real || (apelidos_descricoes[0] || 'Pessoa'));
        }
      }
    }

    return uniq(nomesOuApelidosMencionados);
  } catch (error) {
    console.error('Erro ao processar vínculos:', error);
    return [];
  }
}

// Seleciona vínculos relevantes para a mensagem atual.
// Prioriza pessoas citadas; se nada for citado, retorna top 3 por frequência/recência.
async function selecionarVinculosParaContexto(user_id, nomesOuApelidos = []) {
  const { data: todos } = await supabase
    .from('vinculos_usuario')
    .select('nome_real, apelidos_descricoes, marcador_emocional, contextos_relevantes, perfil_compacto, frequencia_mencao, ultima_mencao')
    .eq('user_id', user_id);

  if (!todos || todos.length === 0) return [];

  const lower = s => (s || '').toLowerCase();
  const citados = [];
  if (nomesOuApelidos.length) {
    for (const v of todos) {
      const matchPorNome = nomesOuApelidos.some(n => lower(v.nome_real) === lower(n));
      const aliases = Array.isArray(v.apelidos_descricoes) ? v.apelidos_descricoes.map(a => lower(a)) : [];
      const matchPorAlias = nomesOuApelidos.some(n => aliases.includes(lower(n)));
      if (matchPorNome || matchPorAlias) citados.push(v);
    }
  }

  if (citados.length > 0) {
    // limita a no máx. 5
    return citados.slice(0, 5);
  }

  // Fallback: top 3 por frequência e recência
  return [...todos]
    .sort((a, b) => (b.frequencia_mencao || 0) - (a.frequencia_mencao || 0) || new Date(b.ultima_mencao || 0) - new Date(a.ultima_mencao || 0))
    .slice(0, 3);
}

function montarBlocoVinculos(vinculos) {
  if (!vinculos || vinculos.length === 0) return 'Sem pessoas relevantes detectadas para esta conversa.';
  let out = 'Pessoas relevantes para considerar nesta resposta (perfis compactos):\n';
  vinculos.forEach(v => {
    const emoc = Array.isArray(v.marcador_emocional) ? v.marcador_emocional.join(', ') : '';
    const ctx = Array.isArray(v.contextos_relevantes) ? v.contextos_relevantes.join(' / ') : '';
    out += `- ${v.perfil_compacto || `${v.nome_real} — emoções: ${emoc || '—'}; contextos: ${ctx || '—'}`}\n`;
  });
  return out;
}

// ---------------------------------------------------------------------
// Rotas já existentes
// ---------------------------------------------------------------------

// Rota para cadastrar pessoas importantes (form manual opcional)
app.post('/pessoas', async (req, res) => {
  try {
    const { user_id, pessoas } = req.body;
    if (!user_id || !Array.isArray(pessoas)) {
      return res.status(400).json({ erro: 'Dados inválidos' });
    }
    const { data, error } = await supabase
      .from('pessoas_importantes')
      .insert(
        pessoas.map(p => ({
          user_id,
          nome: p.nome,
          apelido: p.apelido,
          relacao: p.relacao,
          sentimento: p.sentimento,
        })),
      );
    if (error) {
      console.error('Erro Supabase:', error);
      return res.status(500).json({ erro: 'Erro ao salvar no banco' });
    }
    res.json({ sucesso: true, pessoas: data });
  } catch (err) {
    console.error('Erro geral:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// Cadastro
app.post('/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  }

  const { data: usuarios, error: errorSelect } = await supabase
    .from('usuarios')
    .select('*')
    .eq('email', email);

  if (errorSelect) return res.status(500).json({ erro: 'Erro no banco de dados.' });
  if (usuarios && usuarios.length > 0) return res.status(409).json({ erro: 'E-mail já cadastrado.' });

  const senhaHash = await bcrypt.hash(senha, 10);

  const { error: errorInsert } = await supabase.from('usuarios').insert([{ nome, email, senha_hash: senhaHash }]);
  if (errorInsert) return res.status(500).json({ erro: 'Erro ao cadastrar usuário.' });

  return res.status(201).json({ mensagem: 'Cadastro realizado com sucesso!' });
});

// Login
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  }
  const { data: usuarios, error } = await supabase.from('usuarios').select('*').eq('email', email);
  if (error) return res.status(500).json({ erro: 'Erro no banco de dados.' });
  if (!usuarios || usuarios.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  const usuario = usuarios[0];
  const senhaConfere = await bcrypt.compare(senha, usuario.senha_hash);
  if (!senhaConfere) return res.status(401).json({ erro: 'Senha incorreta.' });

  return res.json({ mensagem: `Login autorizado! Bem-vindo(a), ${usuario.nome}`, user_id: usuario.id, nome: usuario.nome });
});

// Teste de tagging
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

// Nova sessão
app.post('/sessao', async (req, res) => {
  const { user_id, mensagem } = req.body;
  if (!user_id || !mensagem) return res.status(400).json({ erro: 'Informe user_id e mensagem.' });

  const data_sessao = new Date().toISOString();
  const resumo = mensagem;
  const status = 'aberta';
  const tags_tema = [];
  const tags_risco = [];
  const sentimentos_reportados = '';

  const { data, error } = await supabase
    .from('sessoes')
    .insert([{ user_id, data_sessao, resumo, status, pendencias: '', tags_tema, tags_risco, sentimentos_reportados }])
    .select();

  if (error) return res.status(500).json({ erro: 'Erro ao registrar sessão.' });

  return res.status(201).json({ mensagem: 'Sessão registrada com sucesso!', sessao: data[0] });
});

// Listar sessões do usuário
app.get('/sessoes/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.status(400).json({ erro: 'Informe o user_id.' });

  const { data, error } = await supabase
    .from('sessoes')
    .select('id, data_sessao, resumo, tags_tema, tags_risco, sentimentos_reportados, status')
    .eq('user_id', user_id)
    .order('data_sessao', { ascending: false });

  if (error) return res.status(500).json({ erro: 'Erro ao buscar sessões.' });
  return res.json({ sessoes: data });
});

// Contexto completo (permanece como diagnóstico/apoio)
async function montarContextoCompleto(user_id) {
  const { data: perfil } = await supabase
    .from('perfil_psicologico')
    .select('tracos_personalidade, valores_declarados, notas_mentor')
    .eq('user_id', user_id)
    .single();

  const { data: eventos } = await supabase
    .from('eventos_vida')
    .select('tipo_evento, descricao, data_evento')
    .eq('user_id', user_id)
    .order('data_evento', { ascending: false })
    .limit(3);

  const { data: vinculos } = await supabase
    .from('vinculos_usuario')
    .select('tipo_vinculo, nome_real, apelidos_descricoes, marcador_emocional')
    .eq('user_id', user_id);

  const { data: sessoes } = await supabase
    .from('sessoes')
    .select('data_sessao, resumo, tags_tema, tags_risco')
    .eq('user_id', user_id)
    .order('data_sessao', { ascending: false })
    .limit(3);

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

  contexto += `Últimas sessões:\n`;
  sessoes?.forEach(sessao => {
    contexto += `- ${new Date(sessao.data_sessao).toLocaleDateString()}: "${sessao.resumo}" | Temas: ${sessao.tags_tema?.join(', ') || '-'} | Riscos: ${sessao.tags_risco?.join(', ') || '-'}\n`;
  });

  return contexto;
}

// Diagnóstico do contexto completo
app.get('/contexto/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.status(400).json({ erro: 'Informe o user_id.' });

  try {
    const contexto = await montarContextoCompleto(user_id);
    return res.json({ contexto });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao montar contexto.' });
  }
});

// Busca vetorial (mantido)
async function buscarResumosSemelhantes(supabaseClient, openaiClient, user_id, textoConsulta, nResultados = 3) {
  const embeddingResponse = await openaiClient.embeddings.create({
    model: 'text-embedding-3-small',
    input: textoConsulta,
  });
  const novoEmbedding = embeddingResponse.data[0].embedding;
  const { data, error } = await supabaseClient.rpc('buscar_resumos_semelhantes', {
    uid: user_id,
    query_embedding: novoEmbedding,
    n: nResultados,
  });
  if (error) {
    console.error('Erro na busca vetorial:', error);
    return [];
  }
  return data;
}
// (mantém export se algum outro arquivo requer)
module.exports = { buscarResumosSemelhantes };

// ---------------------------------------------------------------------
// INTEGRAÇÃO COM GPT/OPENAI (AlanBot) — enriquecida com vínculos
// ---------------------------------------------------------------------
app.post('/ia', async (req, res) => {
  const { user_id, sessao_id, mensagem } = req.body;
  if (!user_id || !sessao_id || !mensagem) {
    return res.status(400).json({ erro: 'Informe user_id, sessao_id e mensagem.' });
  }

  // 1) Tagging em tempo real
  const tagsTema = await taggearMensagem(openai, mensagem);
  console.log('Tags em tempo real para esta mensagem:', tagsTema);

  // 2) Conteúdos base do Alan por tags
  const conteudosBase = await buscarConteudoBasePorTags(supabase, tagsTema);
  let contextoAlan = '';
  if (conteudosBase && conteudosBase.length > 0) {
    contextoAlan = 'Referências diretas do Alan para os temas detectados nesta mensagem:\n';
    conteudosBase.forEach(item => {
      contextoAlan += `\nTema: ${item.tema}\n`;
      contextoAlan += `Conceito: ${item.conceito}\n`;
      contextoAlan += `Ferramentas/Exercícios: ${item.ferramentas_exercicios}\n`;
      contextoAlan += `Frases/Citações: ${item.frases_citacoes}\n`;
    });
  } else {
    contextoAlan = 'Nenhuma referência específica do Alan encontrada para os temas detectados.\n';
  }

  // 3) Histórico recente (usuário + bot)
  const { data: historicoUsuario, error: errorUsuario } = await supabase
    .from('mensagens_sessao')
    .select('texto_mensagem, origem, data_mensagem')
    .eq('sessao_id', sessao_id)
    .eq('origem', 'usuario')
    .order('data_mensagem', { ascending: false })
    .limit(20);

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

  let contextoConversa = '';
  const combinado = [...(historicoUsuario || []), ...(historicoBot || [])].sort(
    (a, b) => new Date(a.data_mensagem) - new Date(b.data_mensagem),
  );
  if (combinado.length > 0) {
    contextoConversa = 'Histórico recente da conversa:\n';
    combinado.forEach(msg => {
      contextoConversa += `${msg.origem === 'usuario' ? 'Usuário' : 'Bot'}: ${msg.texto_mensagem}\n`;
    });
  }

  // 4) Memórias vetoriais relevantes
  const memoriasRelevantes = await buscarResumosSemelhantes(supabase, openai, user_id, mensagem, 3);
  let contextoMemorias = 'Memórias relevantes do histórico:\n';
  memoriasRelevantes.forEach(mem => {
    contextoMemorias += `- ${mem.resumo}\n`;
  });

  // 5) Atualiza vínculos com base na mensagem + escolhe perfis para contexto
  const nomesOuApelidos = await processarVinculosUsuario(mensagem, user_id);
  const vinculosContexto = await selecionarVinculosParaContexto(user_id, nomesOuApelidos);
  const contextoVinculos = montarBlocoVinculos(vinculosContexto);

  // 6) Contexto “estático” do usuário (perfil/eventos/últimas sessões)
  const contexto = await montarContextoCompleto(user_id);

  // 7) Prompt final
  const prompt = `
1. Função Essencial
Você é a versão virtual do Alan Fernandes, mentor de autoconhecimento. Sua missão é guiar pessoas no desenvolvimento de habilidades e estratégias mentais, emocionais e comportamentais, ajudando-as a reconhecer e transformar estratégias inconscientes de vida em escolhas conscientes e intencionais.

2. Estilo de Comunicação
Use uma linguagem informal, acolhedora, instrutiva, provocadora e firme.
Adapte-se ao nível de instrução do usuário, do simples ao sofisticado.
Seja cordial, educado e acolhedor, sem bajulação nem validação excessiva.
Ajude o usuário a se questionar com clareza e profundidade, usando perguntas reflexivas, exemplos práticos, metáforas e provocações.
Nunca sobrecarregue o usuário com muita informação. A cada início de conversa comece fazendo perguntas que te dêem uma noção melhor sobre o que o cliente quer falar. Faça 1 pergunta por vez. Em exercícios, dê no máximo 2 opções.
Respeite sempre o ritmo e o estágio de desenvolvimento de cada pessoa.

2A. Referência ao Alan real — Autoridade e Citações
Quando cabível, utilize citações/paráfrases do Alan real. Use no máximo 1 citação a cada 5 respostas.

3. Base de Conhecimento
Priorize materiais autorais do Alan. Como complemento, use autores consagrados (Jung, Hollis, Gabor Maté, etc.) citando obra/autor ao usar conceitos diretos. Nunca invente ou alucine.

4. Ética e Postura
Não dê diagnósticos clínicos, nem dicas mágicas. Provoque reflexão e ofereça caminhos de escolha. Em risco grave (ideação suicida, violência), interrompa a abordagem habitual, acolha, e oriente ajuda especializada.

-------------------------------

PESSOAS CITADAS E CONTEXTO (para personalizar a resposta):
${contextoVinculos}

CONTEXTO CONTEÚDO BASE
${contextoAlan}

HISTÓRICO DA CONVERSA:
${contextoConversa}

MEMÓRIAS RELEVANTES:
${contextoMemorias}

MOLDURA DO USUÁRIO (perfil/eventos/últimas sessões):
${contexto}

MENSAGEM DO USUÁRIO:
"${mensagem}"
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: prompt }],
    });
    const resposta = completion.choices[0].message.content;

    // Salva a resposta do bot
    await supabase.from('mensagens_sessao').insert([
      {
        sessao_id,
        user_id,
        texto_mensagem: resposta,
        origem: 'bot',
      },
    ]);

    return res.json({ resposta });
  } catch (error) {
    console.error('Erro GPT:', error);
    return res.status(500).json({ erro: 'Erro ao gerar resposta da IA.' });
  }
});

// Salvar mensagem individual na sessão (agora também processa vínculos se for do usuário)
app.post('/mensagem', async (req, res) => {
  const { sessao_id, user_id, texto_mensagem, origem } = req.body;
  if (!sessao_id || !user_id || !texto_mensagem) {
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  }

  try {
    const { data, error } = await supabase.from('mensagens_sessao').insert([
      {
        sessao_id,
        user_id,
        texto_mensagem,
        origem: origem || 'usuario',
      },
    ]);
    if (error) throw error;

    if ((origem || 'usuario') === 'usuario') {
      await processarVinculosUsuario(texto_mensagem, user_id);
    }

    res.status(201).json({ success: true, mensagem: 'Mensagem salva!', data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Histórico da sessão
app.get('/historico/:sessao_id', async (req, res) => {
  const { sessao_id } = req.params;
  try {
    const { data, error } = await supabase
      .from('mensagens_sessao')
      .select('*')
      .eq('sessao_id', sessao_id)
      .order('data_mensagem', { ascending: true });
    if (error) throw error;
    res.status(200).json({ mensagens: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Finalizar sessão (mantido com embeddings)
app.post('/finalizar-sessao', async (req, res) => {
  const { sessao_id } = req.body;
  if (!sessao_id) return res.status(400).json({ error: 'sessao_id obrigatório' });

  try {
    const { data: mensagens, error } = await supabase
      .from('mensagens_sessao')
      .select('*')
      .eq('sessao_id', sessao_id)
      .order('data_mensagem', { ascending: true });

    if (error) throw error;
    if (!mensagens.length) return res.status(404).json({ error: 'Sessão não encontrada ou sem mensagens' });

    const textoSessao = mensagens
      .map(msg => (msg.origem === 'usuario' ? 'Usuário: ' : 'Bot: ') + msg.texto_mensagem)
      .join('\n');

    const listaTagsTema = [
      'ansiedade e medo do futuro',
      'autoconfianca e coragem para mundancas',
      'autoconhecimento',
      'autoestima e autovalor',
      'autosabotagem e procrastinacao',
      'carreira e prosperidade',
      'carreira trabalho e prosperidade',
      'comunicacao e assertividade',
      'conflitos conjugais / amorosos',
      'culpa perdao e reconciliacao',
      'dependencia emocional',
      'espiritualidade e conexao emocional',
      'espiritualidade e conexao existencial',
      'limites autonomia e assertividade',
      'luto perdas e recomecos',
      'medo ansiedade e gestao de emocoes dificeis',
      'mudancas adaptacao e ciclos de vida',
      'procrastinacao e gestao de tempo',
      'proposito e sentido de vida',
      'proposito realizacao e construcao de futuro',
      'relacionamentos familiares',
      'saude emocional e autocuidado',
      'saude fisica autocuidado e corpo como aliado (saude cem)',
      'sexualidade e autoaceitacao do prazer',
      'traumas e feridas emocionais',
      'vergonha medo de exposicao e aceitacao social',
      'vulnerabilidade vergonha e autenticidade',
    ];
    const listaTagsRisco = [
      'ideacao_suicida',
      'autolesao',
      'violencia_domestica_(sofrida_ou_praticada)',
      'violencia_sexual',
      'abuso_fisico_ou_psicologico',
      'isolamento_extremo',
      'desamparo_total_(sentimento_de_abandono,desesperanca_intensa)',
      'ataques_de_panico_recorrentes',
      'crise_psicotica/agitacao_grave',
      'dependencia_quimica_ativa(com_risco_de_vida)',
      'recusa_total_de_ajuda_diante_de_sofrimento_grave',
    ];

    const prompt = `
Você é um mentor virtual. Analise o texto da sessão a seguir e faça:

1. Escreva um resumo objetivo dos principais pontos da sessão com no máximo 750 palavras. Inclua: pergunta/dilema central; trechos literais das mensagens do usuário (ignore respostas do bot); síntese da sessão; compromissos e perguntas abertas.
2. Liste os temas abordados, escolhendo só 2 entre: ${listaTagsTema}
3. Liste os riscos detectados, escolhendo entre: ${listaTagsRisco}

Sessão:
"""
${textoSessao}
"""

Retorne APENAS JSON:
{"resumo":"...", "tags_tema":["...","..."], "tags_risco":["..."]}
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Você é um mentor virtual especialista em psicologia e autoconhecimento.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 600,
    });

    let conteudo = completion.choices[0].message.content;
    conteudo = conteudo.replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    const gptResposta = safeParseJSON(conteudo);
    if (!gptResposta) {
      return res.status(500).json({ error: 'Erro ao interpretar resposta do GPT', resposta_bruta: completion.choices[0].message.content });
    }

    const { error: updateError } = await supabase
      .from('sessoes')
      .update({
        resumo: gptResposta.resumo,
        tags_tema: gptResposta.tags_tema,
        tags_risco: gptResposta.tags_risco,
        status: 'fechada',
      })
      .eq('id', sessao_id);

    if (updateError) throw updateError;

    // Embedding do resumo
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: gptResposta.resumo,
    });
    const embedding = emb.data[0].embedding;

    const { data: sessaoInfo, error: sessaoError } = await supabase
      .from('sessoes')
      .select('user_id')
      .eq('id', sessao_id)
      .single();
    if (sessaoError || !sessaoInfo) throw new Error('Sessão não encontrada para vincular user_id ao embedding');

    const { error: embError } = await supabase.from('session_embeddings').insert([
      {
        user_id: sessaoInfo.user_id,
        sessao_id,
        resumo: gptResposta.resumo,
        embedding,
      },
    ]);
    if (embError) throw embError;

    res.status(200).json({ sucesso: true, ...gptResposta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});


