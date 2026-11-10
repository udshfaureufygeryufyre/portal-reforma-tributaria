const express = require('express');
const path = require('path');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const TOTAL_NOTICIAS = 10;

function normalizarUrl(valor) {
  try {
    const url = new URL(String(valor || '').trim());

    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }

    url.hash = '';
    url.search = '';

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    return `${url.protocol}//${host}${pathname}`;
  } catch {
    return '';
  }
}

function normalizarTexto(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function palavrasRelevantes(valor) {
  const ignorar = new Set([
    'a', 'as', 'o', 'os', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das',
    'e', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'com', 'que',
    'sobre', 'mais', 'como', 'se', 'ao', 'aos', 'foi', 'ser', 'sao',
    'sua', 'seu', 'entre', 'apos', 'durante', 'reforma', 'tributaria',
    'noticia', 'noticias', 'brasil', '2026'
  ]);

  return new Set(
    normalizarTexto(valor)
      .split(' ')
      .filter(palavra => palavra.length > 2 && !ignorar.has(palavra))
  );
}

function similaridadeTexto(a, b) {
  const palavrasA = palavrasRelevantes(a);
  const palavrasB = palavrasRelevantes(b);

  if (!palavrasA.size || !palavrasB.size) {
    return 0;
  }

  let intersecao = 0;
  for (const palavra of palavrasA) {
    if (palavrasB.has(palavra)) intersecao++;
  }

  const uniao = new Set([...palavrasA, ...palavrasB]).size;
  return uniao ? intersecao / uniao : 0;
}

function extrairJson(texto) {
  if (!texto || typeof texto !== 'string') return null;

  const limpo = texto
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const tentativas = [limpo];

  const inicioArray = limpo.indexOf('[');
  const fimArray = limpo.lastIndexOf(']');
  if (inicioArray >= 0 && fimArray > inicioArray) {
    tentativas.push(limpo.slice(inicioArray, fimArray + 1));
  }

  const inicioObjeto = limpo.indexOf('{');
  const fimObjeto = limpo.lastIndexOf('}');
  if (inicioObjeto >= 0 && fimObjeto > inicioObjeto) {
    tentativas.push(limpo.slice(inicioObjeto, fimObjeto + 1));
  }

  for (const tentativa of tentativas) {
    try {
      const valor = JSON.parse(tentativa);

      if (Array.isArray(valor)) return valor;
      if (Array.isArray(valor?.news)) return valor.news;
      if (Array.isArray(valor?.noticias)) return valor.noticias;
      if (Array.isArray(valor?.articles)) return valor.articles;
    } catch {
      // Tenta o próximo formato possível.
    }
  }

  return null;
}

function extrairFontesVerificadas(resposta) {
  const urls = new Set();
  const fontes = new Map();

  for (const candidato of resposta?.candidates || []) {
    const metadados =
      candidato?.groundingMetadata ||
      candidato?.grounding_metadata ||
      {};

    const trechos =
      metadados.groundingChunks ||
      metadados.grounding_chunks ||
      [];

    for (const trecho of trechos) {
      const web = trecho?.web || trecho?.retrievedContext || trecho;
      const urlOriginal = web?.uri || web?.url || '';
      const urlNormalizada = normalizarUrl(urlOriginal);

      if (!urlNormalizada) continue;

      urls.add(urlNormalizada);

      if (web?.title) {
        fontes.set(urlNormalizada, web.title);
      }
    }
  }

  return { urls, fontes };
}

function prepararNoticias(lista, fontesVerificadas) {
  const noticias = [];

  for (const item of lista || []) {
    const titulo = String(
      item?.title || item?.titulo || item?.headline || ''
    ).trim();

    const resumo = String(
      item?.summary || item?.resumo || item?.description || item?.snippet || ''
    ).trim();

    const urlOriginal = item?.url || item?.link || item?.uri || '';
    const url = normalizarUrl(urlOriginal);

    if (!titulo || !resumo || !url) continue;

    // Só aceita endereços que o próprio Gemini retornou como fonte da busca.
    if (!fontesVerificadas.urls.has(url)) continue;

    const data = String(
      item?.date ||
      item?.data ||
      item?.publishedAt ||
      item?.published_at ||
      ''
    ).trim();

    const dataInterpretada = data ? Date.parse(data) : NaN;

    // Não exibe notícia com data futura, quando a data pode ser interpretada.
    if (Number.isFinite(dataInterpretada) && dataInterpretada > Date.now()) {
      continue;
    }

    noticias.push({
      title: titulo,
      summary: resumo,
      url,
      source: String(
        item?.source ||
        item?.fonte ||
        item?.publisher ||
        fontesVerificadas.fontes.get(url) ||
        ''
      ).trim(),
      date: data
    });
  }

  noticias.sort((a, b) => {
    const dataA = Date.parse(a.date);
    const dataB = Date.parse(b.date);

    if (Number.isFinite(dataA) && Number.isFinite(dataB)) {
      return dataB - dataA;
    }
    if (Number.isFinite(dataA)) return -1;
    if (Number.isFinite(dataB)) return 1;
    return 0;
  });

  const unicas = [];

  for (const noticia of noticias) {
    const duplicada = unicas.some(existente => {
      if (existente.url === noticia.url) return true;

      const titulosParecidos =
        similaridadeTexto(existente.title, noticia.title) >= 0.72;

      const resumosParecidos =
        similaridadeTexto(existente.summary, noticia.summary) >= 0.78;

      return titulosParecidos || resumosParecidos;
    });

    if (!duplicada) {
      unicas.push(noticia);
    }
  }

  return unicas.slice(0, TOTAL_NOTICIAS);
}

async function buscarNoGemini(consulta) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

    const instrucao = `
Pesquise na web notícias e atos publicados sobre o tema abaixo.

Tema: "${consulta}"
Data atual: ${new Date().toISOString().slice(0, 10)}

Retorne somente notícias reais, distintas entre si e encontradas nas fontes da busca.
Não invente títulos, datas, resumos, órgãos ou endereços.
Não transforme a mesma notícia em vários itens mudando apenas algumas palavras.
Priorize as publicações mais recentes e relevantes.
Use exclusivamente URLs de páginas encontradas na pesquisa.
Inclua a data de publicação quando estiver disponível.
Escreva um resumo factual e curto, sem acrescentar informações que a fonte não sustente.

Retorne somente JSON válido, sem Markdown, neste formato:
{
  "news": [
    {
      "title": "Título da notícia ou do ato",
      "summary": "Resumo factual da notícia",
      "url": "URL completa da página original",
      "source": "Nome do veículo, órgão ou publicação",
      "date": "Data de publicação, se disponível"
    }
  ]
}

Retorne no máximo ${TOTAL_NOTICIAS} itens. Se encontrar menos de ${TOTAL_NOTICIAS}
notícias distintas e verificáveis, retorne apenas as que encontrou. Não complete a lista
com conteúdo inventado ou repetido.
`.trim();

    const response = await fetch(
      `${endpoint}?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: instrucao }]
            }
          ],
          tools: [{ google_search: {} }]
        })
      }
    );

    const dados = await response.json().catch(() => ({}));

    if (!response.ok) {
      const mensagem =
        dados?.error?.message ||
        `O Gemini respondeu com o erro HTTP ${response.status}.`;

      throw new Error(mensagem);
    }

    const candidato = dados?.candidates?.[0];
    const texto = candidato?.content?.parts
      ?.map(parte => parte?.text || '')
      .filter(Boolean)
      .join('\n');

    if (!texto) {
      throw new Error('O Gemini não retornou conteúdo de notícias.');
    }

    return {
      resposta: dados,
      lista: extrairJson(texto) || []
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.post('/api/buscar-noticias', async (req, res) => {
  const consulta = String(req.body?.query || '').trim();

  if (consulta.length < 3) {
    return res.status(400).json({
      error: 'Informe um tema de busca com pelo menos 3 caracteres.'
    });
  }

  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      error:
        'A chave GEMINI_API_KEY não está configurada nas variáveis do aplicativo no Fly.io. Nenhuma notícia fictícia foi exibida.'
    });
  }

  try {
    // Três consultas ajudam a encontrar fontes diferentes sem preencher
    // os resultados com notícias inventadas ou versões repetidas.
    const consultas = [
      `${consulta} notícias recentes publicadas`,
      `${consulta} atos oficiais decisões legislação recentes`,
      `${consulta} notícias recentes imprensa economia`
    ];

    const resultados = await Promise.allSettled(
      consultas.map(buscarNoGemini)
    );

    const noticiasEncontradas = [];
    const fontesVerificadas = {
      urls: new Set(),
      fontes: new Map()
    };

    let buscasComSucesso = 0;

    for (const resultado of resultados) {
      if (resultado.status !== 'fulfilled') {
        console.error('Falha em uma consulta ao Gemini:', resultado.reason?.message);
        continue;
      }

      buscasComSucesso++;

      for (const url of resultado.value.resposta
        ? extrairFontesVerificadas(resultado.value.resposta).urls
        : []) {
        fontesVerificadas.urls.add(url);
      }

      const fontesDaConsulta = extrairFontesVerificadas(
        resultado.value.resposta
      );

      for (const [url, nome] of fontesDaConsulta.fontes) {
        fontesVerificadas.fontes.set(url, nome);
      }

      noticiasEncontradas.push(...resultado.value.lista);
    }

    if (buscasComSucesso === 0) {
      return res.status(502).json({
        error:
          'Não foi possível concluir a busca no Gemini. Confira a chave, o modelo e os registros do aplicativo no Fly.io.'
      });
    }

    const news = prepararNoticias(noticiasEncontradas, fontesVerificadas);

    return res.json({
      news,
      count: news.length,
      requested: TOTAL_NOTICIAS,
      complete: news.length === TOTAL_NOTICIAS,
      message:
        news.length === TOTAL_NOTICIAS
          ? 'Foram encontradas 10 notícias distintas com links verificados.'
          : `A busca encontrou ${news.length} notícia(s) distinta(s) com links verificados. Não foram adicionados resultados inventados para completar 10.`
    });
  } catch (erro) {
    console.error('Erro na rota /api/buscar-noticias:', erro);

    return res.status(502).json({
      error: erro?.name === 'AbortError'
        ? 'A busca demorou demais para responder. Tente novamente.'
        : erro?.message || 'Erro inesperado ao buscar notícias.'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal-reforma-tributaria.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
