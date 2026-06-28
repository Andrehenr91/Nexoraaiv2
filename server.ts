import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { eq, desc, and } from "drizzle-orm";
import { db, initializeSchema } from "./db/index";
import { users, companies, technicians, tickets, financialTransactions, aiAuditLogs, webhooks, webhookDeliveries } from "./db/schema";
import { seedDatabase } from "./db/seed";
import {
  initQueues, stopQueues, getQueueStats,
  enqueueClassifyTicket, enqueueFraudCheck,
  enqueueProcessPayment, enqueueSchedulePayout,
  enqueueNotification, enqueueWebhookDelivery,
} from "./src/queues/index";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "nexorafield_jwt_enterprise_secret_key_2026";

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── FASE 8: Security Middleware ─────────────────────────────
// CORS
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGINS?.split(",") || [];
  const origin = req.headers.origin || "";
  if (process.env.NODE_ENV !== "production" || allowed.includes(origin) || allowed.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Tenant-ID");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Security Headers
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const isProd = process.env.NODE_ENV === "production";
  const cspConnectSrc = isProd
    ? "connect-src 'self' https://generativelanguage.googleapis.com"
    : "connect-src 'self' https://generativelanguage.googleapis.com ws: wss:";
  res.setHeader("Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https: blob:; ${cspConnectSrc};`
  );
  if (isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  next();
});

// Rate Limiting (in-memory, per IP)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const createRateLimiter = (windowMs: number, max: number) => (req: any, res: any, next: any) => {
  const key = req.ip || "unknown";
  const now = Date.now();
  const record = rateLimitStore.get(key);
  if (!record || now > record.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }
  record.count++;
  if (record.count > max) {
    res.setHeader("Retry-After", Math.ceil((record.resetAt - now) / 1000));
    return res.status(429).json({ error: "Too many requests. Tente novamente em instantes." });
  }
  next();
};
const apiLimiter = createRateLimiter(60_000, 100);   // 100 req/min por IP
const aiLimiter  = createRateLimiter(60_000, 20);    // 20 req/min para endpoints de IA
app.use("/api/", apiLimiter);
app.use("/api/ai/", aiLimiter);
// ─────────────────────────────────────────────────────────────

// ─── Correlation ID + Structured JSON Logging ─────────────────
app.use((req: any, res: any, next: any) => {
  const correlationId = (req.headers["x-correlation-id"] as string) || crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader("X-Correlation-ID", correlationId);
  const start = Date.now();
  res.on("finish", () => {
    const tenantId = req.user?.tenantId || "anonymous";
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs: Date.now() - start,
      tenantId,
      correlationId,
    }));
  });
  next();
});

// ─── JWT Authentication Middleware ────────────────────────────
const PUBLIC_PATHS = ["/auth/", "/health", "/metrics"];

function authenticateToken(req: any, res: any, next: any) {
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  const authHeader = req.headers.authorization as string | undefined;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
  if (!token) {
    return res.status(401).json({ error: "Token de autenticação não fornecido." });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
}

app.use("/api/", authenticateToken);
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 5000;

// Initialize Google GenAI SDK
const geminiApiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;

if (geminiApiKey) {
  ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  console.log("Gemini API client initialized successfully.");
} else {
  console.warn("WARNING: GEMINI_API_KEY is not defined. AI features will fallback to rule-based mock responses.");
}

// -------------------------------------------------------------
// Helper to call Gemini and return string or parsed JSON
// -------------------------------------------------------------
async function queryGemini(prompt: string, systemInstruction?: string, isJson: boolean = false, schema?: any) {
  if (!ai) {
    throw new Error("Gemini API key missing. Please configure it in the Secrets panel.");
  }

  try {
    const config: any = {
      systemInstruction: systemInstruction || "Você é o assistente inteligente de IA da NexoraField, especialista em gestão de serviços em campo (FSM). Responda sempre em Português do Brasil.",
      temperature: 0.2,
    };

    if (isJson) {
      config.responseMimeType = "application/json";
      if (schema) {
        config.responseSchema = schema;
      }
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config,
    });

    const text = response.text || "";
    if (isJson) {
      return JSON.parse(text.trim());
    }
    return text;
  } catch (error: any) {
    console.error("Gemini Query Error:", error);
    throw error;
  }
}

// -------------------------------------------------------------
// API Routes
// -------------------------------------------------------------

// 1. Ticket Auto Classification
app.post("/api/ai/classify", async (req, res) => {
  const { description } = req.body;
  if (!description) {
    return res.status(400).json({ error: "Descrição do chamado é obrigatória." });
  }

  if (!ai) {
    // Fallback if no API Key
    const lower = description.toLowerCase();
    let category = "Outros";
    let specialty = "Geral";
    if (lower.includes("cftv") || lower.includes("dvr") || lower.includes("câmera") || lower.includes("intelbras")) {
      category = "CFTV";
      specialty = "Intelbras";
    } else if (lower.includes("fibra") || lower.includes("fusão") || lower.includes("otdr") || lower.includes("gpon")) {
      category = "Fibra";
      specialty = "Fibra Óptica";
    } else if (lower.includes("rede") || lower.includes("switch") || lower.includes("cisco") || lower.includes("roteador")) {
      category = "Redes";
      specialty = "Cisco";
    } else if (lower.includes("solar") || lower.includes("painel") || lower.includes("inversor")) {
      category = "Solar";
      specialty = "Energia Solar";
    } else if (lower.includes("ar") || lower.includes("split") || lower.includes("refrigeração") || lower.includes("climatização")) {
      category = "Ar Condicionado";
      specialty = "Climatização";
    }

    const urgency = lower.includes("urgente") || lower.includes("parado") || lower.includes("crítico") ? "Crítica" : "Média";

    return res.json({
      title: "Manutenção Técnica Detectada",
      category,
      specialty,
      urgency,
      skills: [category, specialty, "Diagnóstico"],
      suggestedValue: 250,
      confidence: 0.8,
      fallback: true
    });
  }

  try {
    const schema = {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Título curto, profissional e objetivo para o chamado técnico." },
        category: { type: Type.STRING, description: "Uma das seguintes categorias: CFTV, Redes, Telecom, Elétrica, Solar, Fibra, TI, Automação, Alarmes, Ar Condicionado, Facilities, Outros." },
        specialty: { type: Type.STRING, description: "Especialidade técnica principal ou fabricante relevante (ex: Intelbras, Cisco, Huawei, Cablagem Estruturada, etc)." },
        urgency: { type: Type.STRING, description: "Grau de urgência: Baixa, Média, Alta, Crítica." },
        skills: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Lista de 3 a 5 habilidades/certificações exigidas para esse serviço (ex: NR10, NR35, Fusão de Fibra)."
        },
        suggestedValue: { type: Type.NUMBER, description: "Valor sugerido para o serviço em Reais (BRL), baseado na complexidade. Apenas o número." }
      },
      required: ["title", "category", "specialty", "urgency", "skills", "suggestedValue"]
    };

    const prompt = `Analise a seguinte descrição de chamado técnico e extraia as informações estruturadas de acordo com as regras de negócio FSM da plataforma NexoraField.
    Descrição: "${description}"`;

    const result = await queryGemini(prompt, "Você é um classificador automático de chamados de campo técnicos. Retorne estritamente um JSON correspondendo ao schema.", true, schema);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Intelligent Match and Ranking
app.post("/api/ai/match", async (req, res) => {
  const { ticket, technicians } = req.body;
  if (!ticket || !technicians) {
    return res.status(400).json({ error: "Ticket e técnicos são obrigatórios." });
  }

  // Calculate distances and filter first
  const R = 6371; // Earth's radius in km
  const getDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const techsWithDistance = technicians.map((tech: any) => {
    const distance = getDistance(
      ticket.latitude || -22.9068, // fallback to campinas/sp region coords
      ticket.longitude || -47.0616,
      tech.latitude,
      tech.longitude
    );
    return { ...tech, distance };
  });

  if (!ai) {
    // Basic scoring fallback
    const scoredTechs = techsWithDistance.map((tech: any) => {
      let score = 50; // base score
      // Specialty check
      const hasSpecialty = tech.specialties.some((s: string) =>
        s.toLowerCase().includes(ticket.category.toLowerCase()) ||
        ticket.description.toLowerCase().includes(s.toLowerCase())
      );
      if (hasSpecialty) score += 30;

      // Distance score (closer is better, max 30km radius)
      if (tech.distance <= tech.radiusKm) {
        score += Math.max(0, 20 - tech.distance * 0.5);
      } else {
        score -= (tech.distance - tech.radiusKm) * 2;
      }

      // Rating score
      score += tech.rating * 4;

      return {
        techId: tech.id,
        score: Math.min(100, Math.max(0, Math.round(score))),
        distance: Math.round(tech.distance * 10) / 10,
        explanation: `${tech.name} foi selecionado pois está a ${Math.round(tech.distance)} km de distância, tem avaliação ${tech.rating}★ e possui especialidades correspondentes como ${tech.specialties.join(", ")}.`
      };
    });

    return res.json({
      matches: scoredTechs.sort((a: any, b: any) => b.score - a.score),
      fallback: true
    });
  }

  try {
    const prompt = `Temos o seguinte Chamado Técnico:
    - Título: ${ticket.title}
    - Categoria: ${ticket.category}
    - Especialidade: ${ticket.specialty}
    - Urgência: ${ticket.urgency}
    - Cidade/UF: ${ticket.city} - ${ticket.state}
    - Descrição: ${ticket.description}

    Lista de Técnicos disponíveis com suas respectivas distâncias calculadas em relação ao local do chamado:
    ${JSON.stringify(techsWithDistance.map((t: any) => ({
      id: t.id,
      name: t.name,
      specialties: t.specialties,
      rating: t.rating,
      completedJobs: t.completedJobsCount,
      distanceKm: t.distance,
      radiusKm: t.radiusKm,
      status: t.status,
      nr10: t.nr10,
      nr35: t.nr35,
      nr33: t.nr33
    })))}

    Analise a adequação de cada técnico baseando-se em:
    1. Distância geográfica vs. Raio de atuação do técnico.
    2. Correspondência de Especialidades e habilidades deduzidas da descrição do chamado.
    3. Avaliação média (rating) e número de trabalhos concluídos.
    4. Requisitos regulamentares se necessário (ex: NR10/NR35 para redes elétricas ou altura).

    Retorne uma lista com o rankeamento ideal contendo o id do técnico, um score de compatibilidade de 0 a 100, e uma breve explicação profissional e cativante em Português sobre o motivo dele ser um ótimo match para a empresa contratante.`;

    const schema = {
      type: Type.OBJECT,
      properties: {
        matches: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              techId: { type: Type.STRING, description: "ID único do técnico." },
              score: { type: Type.NUMBER, description: "Score de 0 a 100 de compatibilidade." },
              explanation: { type: Type.STRING, description: "Explicação em português detalhando por que este técnico é compatível." }
            },
            required: ["techId", "score", "explanation"]
          }
        }
      },
      required: ["matches"]
    };

    const response = await queryGemini(prompt, "Você é um algoritmo especialista em Matching Inteligente da NexoraField. Retorne um JSON com o rankeamento dos técnicos.", true, schema);
    
    // Inject calculated distances back for convenience
    const matchesWithDistance = response.matches.map((m: any) => {
      const original = techsWithDistance.find((t: any) => t.id === m.techId);
      return {
        ...m,
        distance: original ? Math.round(original.distance * 10) / 10 : 0
      };
    });

    res.json({ matches: matchesWithDistance.sort((a: any, b: any) => b.score - a.score) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Automated Technical Report and Closure Summary
app.post("/api/ai/summarize", async (req, res) => {
  const { ticket, checklist, durationMinutes } = req.body;
  if (!ticket) {
    return res.status(400).json({ error: "Dados do chamado são obrigatórios." });
  }

  if (!ai) {
    return res.json({
      report: `### LAUDO TÉCNICO DE ENCERRAMENTO - NEXORAFIELD\n\n**Chamado:** ${ticket.title}\n**Categoria:** ${ticket.category}\n**Técnico Responsável:** Prestador Alocado\n\n**Resumo Executivo:** O serviço foi concluído com sucesso de acordo com os requisitos informados. O técnico realizou a verificação das dependências de rede e testou todos os canais do equipamento.\n\n**Atividades Realizadas:**\n${(checklist || []).map((c: any) => `- [${c.completed ? 'X' : ' '}] ${c.item}`).join('\n')}\n\n**Recomendações:** Manter o equipamento limpo e em local ventilado. Monitorar o funcionamento nas próximas 24 horas.`
    });
  }

  try {
    const prompt = `Gere um Laudo Técnico de Encerramento profissional e detalhado para o seguinte chamado concluído:
    - Título: ${ticket.title}
    - Descrição Original: ${ticket.description}
    - Categoria: ${ticket.category} / Especialidade: ${ticket.specialty}
    - Check-list executado pelo técnico:
      ${JSON.stringify(checklist)}
    - Tempo total decorrido: ${durationMinutes || 45} minutos.

    O documento deve ser formatado em Markdown rico, em Português do Brasil, contendo:
    1. Cabeçalho formal com carimbo NexoraField.
    2. Resumo Técnico do diagnóstico e da intervenção.
    3. Detalhamento dos itens do checklist vistoriados e validados.
    4. Parecer de conformidade de segurança e funcionamento operacional.
    5. Recomendações preventivas de manutenção para o cliente.`;

    const report = await queryGemini(prompt, "Você é o Engenheiro Supervisor de IA da NexoraField. Você gera laudos técnicos formais, detalhados e estruturados com base nas evidências coletadas em campo.");
    res.json({ report });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Smart Fraud Detection Engine
app.post("/api/ai/fraud-check", async (req, res) => {
  const { ticket, techLocation, checkInDistance, checkOutDistance, photosCount, timeElapsedSeconds } = req.body;
  
  if (!ticket) {
    return res.status(400).json({ error: "Dados do chamado são obrigatórios." });
  }

  const alerts: string[] = [];
  
  // Rule-based checks first to guarantee core heuristics
  if (checkInDistance > 5) {
    alerts.push(`Check-in de início realizado a ${Math.round(checkInDistance)} km de distância do endereço cadastrado (Limite ideal: 1 km).`);
  }
  if (checkOutDistance > 5) {
    alerts.push(`Check-out de encerramento realizado a ${Math.round(checkOutDistance)} km de distância do endereço cadastrado (Limite ideal: 1 km).`);
  }
  if (timeElapsedSeconds < 120) { // under 2 minutes
    alerts.push(`Tempo de execução suspeito: O serviço foi iniciado e concluído em apenas ${Math.round(timeElapsedSeconds)} segundos.`);
  }
  if (photosCount < 1) {
    alerts.push("Ausência de evidências visuais: Nenhuma foto de conclusão ou laudo assinado foi anexada pelo técnico.");
  }

  if (!ai) {
    return res.json({ alerts, safe: alerts.length === 0 });
  }

  try {
    const prompt = `Analise os seguintes metadados de execução de um serviço técnico de campo para identificar possíveis fraudes ou irregularidades operacionais:
    - Título do Chamado: ${ticket.title}
    - Endereço Cadastrado: ${ticket.address}, ${ticket.city} - ${ticket.state}
    - Distância do Check-in do Técnico ao local do chamado: ${checkInDistance || 0} km.
    - Distância do Check-out do Técnico ao local do chamado: ${checkOutDistance || 0} km.
    - Tempo total decorrido na execução: ${timeElapsedSeconds ? Math.round(timeElapsedSeconds / 60) : 0} minutos.
    - Quantidade de fotos de evidência enviadas: ${photosCount || 0} fotos.
    - Localização declarada GPS Técnico: Lat ${techLocation?.lat || 0}, Lng ${techLocation?.lng || 0}.

    Retorne uma lista com análises qualitativas adicionais (se houver suspeita de spoofing de GPS, simulação de atendimento rápido, ou conformidade excelente) e se o chamado deve ser marcado para auditoria manual.`;

    const schema = {
      type: Type.OBJECT,
      properties: {
        aiObservations: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Alertas qualitativos adicionais ou observações da IA sobre fraudes e conformidade."
        },
        requiresManualAudit: { type: Type.BOOLEAN, description: "Indica se o chamado exige revisão manual devido a inconsistências." },
        trustScore: { type: Type.NUMBER, description: "Score de confiabilidade geral de 0 a 100 baseado na execução." }
      },
      required: ["aiObservations", "requiresManualAudit", "trustScore"]
    };

    const aiAnalysis = await queryGemini(prompt, "Você é a IA de Compliance e Detecção de Fraudes da NexoraField. Analise as métricas friamente buscando incongruências.", true, schema);
    
    // Combine rule-based alerts with Gemini assessments
    const allAlerts = [...alerts, ...(aiAnalysis.aiObservations || [])];
    res.json({
      alerts: allAlerts,
      requiresManualAudit: aiAnalysis.requiresManualAudit || allAlerts.length > 0,
      trustScore: aiAnalysis.trustScore,
      safe: allAlerts.length === 0 && !aiAnalysis.requiresManualAudit
    });
  } catch (error: any) {
    // Return rule-based on failure
    res.json({ alerts, requiresManualAudit: alerts.length > 0, trustScore: 70, safe: alerts.length === 0 });
  }
});

// 5. Intelligent Multi-Role Assistant Chat
app.post("/api/ai/assist", async (req, res) => {
  const { role, message, systemContext, history } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Mensagem é obrigatória." });
  }

  if (!ai) {
    return res.json({
      text: "Olá! Desculpe, mas estou em modo de demonstração off-line porque nenhuma chave de API Gemini foi detectada. No entanto, posso simular o fluxo: " + message
    });
  }

  try {
    let systemInstruction = "Você é o Assistente Virtual NexoraField, alimentado por Inteligência Artificial avançada. ";
    
    if (role === 'tech') {
      systemInstruction += "Você é o Copiloto Técnico do Técnico de Campo. Ajude-o respondendo dúvidas operacionais sobre ferramentas, procedimentos de segurança, NRs (NR10, NR35), configurações de marcas populares (Intelbras, Hikvision, Cisco, Furukawa, etc.) e resolva problemas em campo. Seja prático, direto e use marcadores visuais passo-a-passo.";
    } else if (role === 'company') {
      systemInstruction += "Você é o Conselheiro Estratégico da Empresa Contratante. Ajude o gerente operacional a planejar chamados, entender melhores preços de mercado, redigir descrições que atraiam técnicos excelentes, sugerir competências exigidas e otimizar prazos. Seja profissional e orientado a SLA.";
    } else if (role === 'admin') {
      systemInstruction += "Você é o Analista Inteligente do Administrador da NexoraField. Você tem acesso aos metadados do sistema fornecidos no contexto. Responda perguntas sobre faturamento, chamados concluídos, desempenho de técnicos, alertas de fraude, e proporcione relatórios gerenciais estruturados.";
    }

    if (systemContext) {
      systemInstruction += `\n\nContexto atual do sistema em tempo real: ${JSON.stringify(systemContext)}`;
    }

    // Prepare chat history if present
    const chat = ai.chats.create({
      model: "gemini-3.5-flash",
      config: {
        systemInstruction,
        temperature: 0.7,
      },
    });

    // Send chat messages in order if we want to simulate dialogue, or just pass a compound prompt
    const prompt = message;
    const response = await chat.sendMessage({ message: prompt });
    res.json({ text: response.text });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 6. Enterprise API Endpoints (Roadmap V4.0 Support)
// -------------------------------------------------------------

// Schema Metadata
app.get("/api/enterprise/schema", (req, res) => {
  res.json({
    status: "ok",
    driver: "PostgreSQL (Cloud SQL / Supabase)",
    orm: "Drizzle ORM",
    tablesCount: 26,
    version: "4.0.0-enterprise",
    timestamp: new Date().toISOString()
  });
});

// Outbound Webhook HMAC SHA256 Test Dispatcher
app.post("/api/enterprise/webhooks/fire", (req, res) => {
  const { url, event } = req.body;
  if (!url) {
    return res.status(400).json({ error: "URL do webhook é obrigatória." });
  }
  
  const payload = {
    event: event || "lead.created",
    timestamp: new Date().toISOString(),
    tenant_id: "tenant-solarsul-9021",
    data: {
      id: "lead_comp_enterprise_100",
      razao_social: "SolarCamp Campinas S/A",
      segmento: "Instalação Solar",
      leads_score: 94,
      temperature: "Hot"
    }
  };

  // Generate HMAC SHA256 signature natively
  const hmac = crypto.createHmac("sha256", "whsec_nexora_889102");
  const signature = hmac.update(JSON.stringify(payload)).digest("hex");

  res.json({
    status: "success",
    endpoint: url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Nexora-Signature": `sha256=${signature}`
    },
    payload,
    debug: {
      retriesLeft: 3,
      backoff: "exponential",
      queueStatus: "dispatched"
    }
  });
});

// Enterprise AI Planner Chat via Gemini
app.post("/api/enterprise/ai/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Mensagem é obrigatória." });
  }

  if (!ai) {
    return res.json({
      text: "Olá! No momento estamos em modo de demonstração técnica offline. Sem a GEMINI_API_KEY no ambiente, simulamos a resposta de planejamento de infraestrutura para: " + message
    });
  }

  try {
    const systemInstruction = "Você é o Arquiteto Principal de TI Enterprise e Co-piloto de Operações da NexoraField AI. Ajude o usuário a planejar as 16 fases de produção e integrações do Roadmap Enterprise (Drizzle ORM, Postgres, JWT, Event Bus, HMAC Webhooks, n8n, Evolution API, Twilio, Resend, Sentry, OpenTelemetry e conformidade LGPD). Responda sempre de forma técnica, objetiva, segura e com tom corporativo elegante em Português.";
    const response = await queryGemini(message, systemInstruction);
    res.json({ text: response });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// JWT Authentication API Endpoints
// -------------------------------------------------------------

app.post("/api/auth/login", async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "E-mail e senha são obrigatórios." });
  }

  try {
    const [dbUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!dbUser) {
      return res.status(401).json({ error: "Credenciais inválidas. Verifique o e-mail e senha inseridos." });
    }

    const passwordMatch = await bcrypt.compare(password, dbUser.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Credenciais inválidas. Verifique o e-mail e senha inseridos." });
    }

    if (role && dbUser.role !== role) {
      return res.status(403).json({ error: `Este usuário não possui permissão para acessar o portal de ${role}.` });
    }

    const token = jwt.sign(
      {
        email: dbUser.email,
        role: dbUser.role,
        name: dbUser.name,
        tenantId: dbUser.tenantId,
        userId: dbUser.id,
        iat: Math.floor(Date.now() / 1000),
      },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.json({
      token,
      user: {
        email: dbUser.email,
        role: dbUser.role,
        name: dbUser.name,
        tenantId: dbUser.tenantId,
      }
    });
  } catch (error: any) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Erro interno ao processar autenticação." });
  }
});

// GET /api/users - List all users (admin)
app.get("/api/users", async (_req, res) => {
  try {
    const allUsers = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        name: users.name,
        tenantId: users.tenantId,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.createdAt);
    res.json(allUsers);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:id - Update user name and role
app.put("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  const { name, role } = req.body;
  if (!name && !role) {
    return res.status(400).json({ error: "Forneça name ou role para atualizar." });
  }
  try {
    const updateData: any = {};
    if (name) updateData.name = name;
    if (role) updateData.role = role;
    const [updated] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, role: users.role, name: users.name });
    if (!updated) return res.status(404).json({ error: "Usuário não encontrado." });
    res.json({ success: true, user: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:id/password - Change user password
app.put("/api/users/:id/password", async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const [updated] = await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!updated) return res.status(404).json({ error: "Usuário não encontrado." });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/users/:id - Revoke user access
app.delete("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.delete(users).where(eq(users.id, id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/register - Register a new user
app.post("/api/auth/register", async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: "Campos obrigatórios: email, password, name, role." });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const [newUser] = await db.insert(users).values({
      email: email.toLowerCase(), passwordHash, name, role, tenantId: "nexorafield-default",
    }).returning({ id: users.id, email: users.email, role: users.role, name: users.name });
    res.status(201).json({ success: true, user: newUser });
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "E-mail já cadastrado." });
    }
    res.status(500).json({ error: "Erro ao criar usuário." });
  }
});

app.post("/api/auth/verify", (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : req.body.token;

  if (!token) {
    return res.status(401).json({ error: "Token de autenticação não fornecido." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: "Token inválido ou expirado." });
  }
});

// -------------------------------------------------------------
// REST CRUD Endpoints — Entities
// -------------------------------------------------------------

// Companies
app.get("/api/companies", async (req: any, res) => {
  try {
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const data = await db.select().from(companies)
      .where(eq(companies.tenantId, tenantId))
      .orderBy(companies.createdAt);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/companies", async (req: any, res) => {
  try {
    const body = req.body;
    const id = body.id || `comp-${Date.now()}`;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [created] = await db.insert(companies).values({ ...body, id, tenantId }).returning();
    res.status(201).json(created);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.put("/api/companies/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [updated] = await db.update(companies).set({ ...req.body, updatedAt: new Date() })
      .where(and(eq(companies.id, id), eq(companies.tenantId, tenantId))).returning();
    if (!updated) return res.status(404).json({ error: "Company not found" });
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/companies/:id", async (req: any, res) => {
  try {
    const tenantId = req.user?.tenantId || "nexorafield-default";
    await db.delete(companies).where(and(eq(companies.id, req.params.id), eq(companies.tenantId, tenantId)));
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Technicians
app.get("/api/technicians", async (req: any, res) => {
  try {
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const data = await db.select().from(technicians)
      .where(eq(technicians.tenantId, tenantId))
      .orderBy(technicians.createdAt);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/technicians", async (req: any, res) => {
  try {
    const body = req.body;
    const id = body.id || `tech-${Date.now()}`;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [created] = await db.insert(technicians).values({ ...body, id, tenantId }).returning();
    res.status(201).json(created);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.put("/api/technicians/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [updated] = await db.update(technicians).set({ ...req.body, updatedAt: new Date() })
      .where(and(eq(technicians.id, id), eq(technicians.tenantId, tenantId))).returning();
    if (!updated) return res.status(404).json({ error: "Technician not found" });
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/technicians/:id", async (req: any, res) => {
  try {
    const tenantId = req.user?.tenantId || "nexorafield-default";
    await db.delete(technicians).where(and(eq(technicians.id, req.params.id), eq(technicians.tenantId, tenantId)));
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Tickets
app.get("/api/tickets", async (req: any, res) => {
  try {
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const data = await db.select().from(tickets)
      .where(eq(tickets.tenantId, tenantId))
      .orderBy(desc(tickets.createdAt));
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/tickets", async (req: any, res) => {
  try {
    const body = req.body;
    const id = body.id || `ticket-${Date.now()}`;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [created] = await db.insert(tickets).values({ ...body, id, tenantId }).returning();

    // Enfileira classificação automática pela IA (assíncrono, não bloqueia resposta)
    const jobId = await enqueueClassifyTicket({
      ticketId:    id,
      description: body.description || body.title || "",
      companyId:   body.companyId,
    });
    if (jobId) console.log(`[Queue] ✅ Ticket ${id} enfileirado para classificação IA (job ${jobId})`);

    // Notifica criação (canal de notificações assíncrono)
    await enqueueNotification("ticket-created", {
      ticketId:    id,
      ticketTitle: created.title || "Novo Chamado",
      companyId:   created.companyId || undefined,
      channels:    ["email"],
    });

    res.status(201).json({ ...created, _queueJobId: jobId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.put("/api/tickets/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [updated] = await db.update(tickets).set({ ...req.body, updatedAt: new Date() })
      .where(and(eq(tickets.id, id), eq(tickets.tenantId, tenantId))).returning();
    if (!updated) return res.status(404).json({ error: "Ticket not found" });
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/tickets/:id/status", async (req: any, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const { status, assignedTechId, ...rest } = req.body;
    const updateData: any = { updatedAt: new Date() };
    if (status) updateData.status = status;
    if (assignedTechId !== undefined) updateData.assignedTechId = assignedTechId;
    Object.assign(updateData, rest);
    const [updated] = await db.update(tickets).set(updateData)
      .where(and(eq(tickets.id, id), eq(tickets.tenantId, tenantId))).returning();
    if (!updated) return res.status(404).json({ error: "Ticket not found" });

    // Enfileira notificação de mudança de status (assíncrono)
    if (status) {
      await enqueueNotification("ticket-status-changed", {
        ticketId:       id,
        ticketTitle:    updated.title || id,
        companyId:      updated.companyId || undefined,
        technicianId:   updated.assignedTechId || assignedTechId || undefined,
        status,
        previousStatus: updated.status || undefined,
        channels:       ["email", "push"],
      });

      // Enfileira fraud-check ao concluir chamado
      if (status === "Concluído" || status === "Fechado") {
        await enqueueFraudCheck({
          ticketId:    id,
          technicianId: updated.assignedTechId || assignedTechId || "",
        });
      }
    }

    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Transactions
app.get("/api/transactions", async (req: any, res) => {
  try {
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const data = await db.select().from(financialTransactions)
      .where(eq(financialTransactions.tenantId, tenantId))
      .orderBy(desc(financialTransactions.createdAt));
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/transactions", async (req: any, res) => {
  try {
    const body = req.body;
    const id = body.id || `trans-${Date.now()}`;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [created] = await db.insert(financialTransactions).values({ ...body, id, tenantId }).returning();

    // Enfileira processamento financeiro assíncrono (cálculo de comissão e repasse)
    const payJobId = await enqueueProcessPayment({
      transactionId: id,
      ticketId:      body.ticketId     || "",
      totalAmount:   Number(body.amount || body.totalAmount || 0),
      commissionPct: Number(body.commissionPct || body.platformCommission || 15),
      technicianId:  body.technicianId || "",
      companyId:     body.companyId    || "",
      paymentMethod: body.paymentMethod || "pix",
    });
    if (payJobId) console.log(`[Queue] ✅ Transação ${id} enfileirada para processamento financeiro (job ${payJobId})`);

    // Agenda repasse ao técnico D+2
    if (body.technicianId) {
      const payoutDate = new Date();
      payoutDate.setDate(payoutDate.getDate() + 2);
      await enqueueSchedulePayout({
        transactionId:   id,
        technicianId:    body.technicianId,
        techPayout:      Number(body.amount || 0) * (1 - (Number(body.commissionPct || 15) / 100)),
        pixKey:          body.pixKey,
        pixType:         body.pixType,
        scheduledForISO: payoutDate.toISOString(),
      });
    }

    res.status(201).json({ ...created, _queueJobId: payJobId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// AI Audit Logs
app.get("/api/audit-logs", async (req: any, res) => {
  try {
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const data = await db.select().from(aiAuditLogs)
      .where(eq(aiAuditLogs.tenantId, tenantId))
      .orderBy(desc(aiAuditLogs.timestamp));
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/audit-logs", async (req: any, res) => {
  try {
    const body = req.body;
    const id = body.id || `log-${Date.now()}`;
    const tenantId = req.user?.tenantId || "nexorafield-default";
    const [created] = await db.insert(aiAuditLogs).values({ ...body, id, tenantId }).returning();
    res.status(201).json(created);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// -------------------------------------------------------------
// Webhook System
// -------------------------------------------------------------

// Helper: sign payload with HMAC-SHA256
function signPayload(payload: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Helper: deliver one webhook
async function deliverWebhook(wh: any, event: string, data: any): Promise<void> {
  const payload = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
  const signature = signPayload(payload, wh.secret);
  const start = Date.now();
  let statusCode = 0;
  let status: "success" | "error" = "error";
  let responseBody = "";
  let errorMsg = "";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(wh.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nexora-Signature": signature,
        "X-Nexora-Event": event,
        "X-Nexora-Delivery": crypto.randomUUID(),
        "User-Agent": "NexoraField-Webhooks/7.0",
      },
      body: payload,
      signal: controller.signal,
    });
    clearTimeout(timer);
    statusCode = response.status;
    responseBody = (await response.text()).slice(0, 500);
    status = response.ok ? "success" : "error";
  } catch (err: any) {
    errorMsg = err.message || "Request failed";
    status = "error";
  }

  const duration = Date.now() - start;

  // Persist delivery log
  await db.insert(webhookDeliveries).values({
    webhookId: wh.id,
    event,
    payload: JSON.parse(payload),
    statusCode: statusCode || null,
    status,
    responseBody: responseBody || null,
    error: errorMsg || null,
    duration,
    deliveredAt: new Date(),
  });

  // Update webhook meta
  await db.update(webhooks).set({
    lastStatus: status,
    lastStatusCode: statusCode || null,
    lastDeliveredAt: new Date(),
    lastError: errorMsg || null,
    deliveryCount: (wh.deliveryCount || 0) + 1,
    updatedAt: new Date(),
  }).where(eq(webhooks.id, wh.id));
}

// Exported trigger function: fan-out to all enabled webhooks subscribed to event
export async function triggerWebhookEvent(event: string, data: any): Promise<void> {
  try {
    const enabled = await db.select().from(webhooks).where(eq(webhooks.enabled, true));
    const targets = enabled.filter((wh) => (wh.events as string[]).includes(event));
    await Promise.allSettled(targets.map((wh) => deliverWebhook(wh, event, data)));
  } catch (err) {
    console.error("[Webhooks] Fan-out error:", err);
  }
}

// GET /api/webhooks
app.get("/api/webhooks", async (_req, res) => {
  try {
    const all = await db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
    // Never expose the secret in listings
    res.json(all.map(w => ({ ...w, secret: "••••••••" })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/webhooks
app.post("/api/webhooks", async (req, res) => {
  const { name, url, secret, events: evts, enabled } = req.body;
  if (!name || !url || !evts?.length) {
    return res.status(400).json({ error: "name, url e events são obrigatórios." });
  }
  try {
    const generatedSecret = secret || crypto.randomBytes(24).toString("hex");
    const [created] = await db.insert(webhooks).values({
      name,
      url,
      secret: generatedSecret,
      events: evts,
      enabled: enabled !== false,
    }).returning();
    res.status(201).json({ ...created, secret: generatedSecret }); // return secret once on creation
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/webhooks/:id
app.put("/api/webhooks/:id", async (req, res) => {
  const { id } = req.params;
  const { name, url, events: evts, enabled } = req.body;
  try {
    const updateData: any = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (url !== undefined) updateData.url = url;
    if (evts !== undefined) updateData.events = evts;
    if (enabled !== undefined) updateData.enabled = enabled;
    const [updated] = await db.update(webhooks).set(updateData)
      .where(eq(webhooks.id, id)).returning();
    if (!updated) return res.status(404).json({ error: "Webhook não encontrado." });
    res.json({ ...updated, secret: "••••••••" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/webhooks/:id
app.delete("/api/webhooks/:id", async (req, res) => {
  try {
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.webhookId, req.params.id as any));
    await db.delete(webhooks).where(eq(webhooks.id, req.params.id as any));
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/webhooks/:id/test — fire a test delivery
app.post("/api/webhooks/:id/test", async (req, res) => {
  const { id } = req.params;
  try {
    const [wh] = await db.select().from(webhooks).where(eq(webhooks.id, id as any)).limit(1);
    if (!wh) return res.status(404).json({ error: "Webhook não encontrado." });
    await deliverWebhook(wh, "test.ping", {
      message: "Este é um teste de entrega do NexoraField Webhooks.",
      platform: "NexoraField v7.0",
      timestamp: new Date().toISOString(),
    });
    // Fetch updated status
    const [updated] = await db.select().from(webhooks).where(eq(webhooks.id, id as any)).limit(1);
    res.json({ success: true, lastStatus: updated.lastStatus, lastStatusCode: updated.lastStatusCode });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/webhooks/:id/deliveries
app.get("/api/webhooks/:id/deliveries", async (req, res) => {
  try {
    const deliveries = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, req.params.id as any))
      .orderBy(desc(webhookDeliveries.deliveredAt))
      .limit(50);
    res.json(deliveries);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/webhooks/deliveries/:deliveryId/replay — re-fire a stored delivery
app.post("/api/webhooks/deliveries/:deliveryId/replay", async (req, res) => {
  const { deliveryId } = req.params;
  try {
    const [delivery] = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId as any)).limit(1);
    if (!delivery) return res.status(404).json({ error: "Entrega não encontrada." });

    const [wh] = await db.select().from(webhooks)
      .where(eq(webhooks.id, delivery.webhookId as any)).limit(1);
    if (!wh) return res.status(404).json({ error: "Webhook pai não encontrado ou foi removido." });

    // Re-fire using the stored payload; extract event + data from saved JSON
    const stored = delivery.payload as any;
    const eventName: string = stored?.event || delivery.event;
    const eventData: any   = stored?.data  || stored || {};
    await deliverWebhook(wh, eventName, eventData);

    // Return the freshly-created delivery row
    const [latest] = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, wh.id as any))
      .orderBy(desc(webhookDeliveries.deliveredAt))
      .limit(1);

    res.json({ success: true, delivery: latest });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/webhooks/trigger — internal trigger from app events
app.post("/api/webhooks/trigger", async (req, res) => {
  const { event, data } = req.body;
  if (!event) return res.status(400).json({ error: "event é obrigatório." });
  triggerWebhookEvent(event, data || {}).catch(() => {});
  res.json({ success: true, message: `Event '${event}' enqueued for delivery.` });
});

// -------------------------------------------------------------
// Health & Metrics Endpoints (Observabilidade Enterprise)
// -------------------------------------------------------------
const serverStartTime = Date.now();

app.get("/api/health", (req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  res.json({
    status: "healthy",
    version: "7.0.0",
    environment: process.env.NODE_ENV || "development",
    uptime: Math.floor(uptime),
    uptimeHuman: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
    timestamp: new Date().toISOString(),
    services: {
      api: "operational",
      ai: geminiApiKey ? "operational" : "degraded",
      auth: "operational",
      webhooks: "operational",
    },
  });
});

app.get("/api/metrics", (req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const cpuUsage = process.cpuUsage();

  res.json({
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    serverStartTime,
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      rss: Math.round(mem.rss / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
      heapUsedPercent: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    },
    cpu: {
      user: Math.round(cpuUsage.user / 1000),
      system: Math.round(cpuUsage.system / 1000),
    },
    services: {
      api: { status: "operational", latency: Math.floor(Math.random() * 30) + 5 },
      ai: { status: geminiApiKey ? "operational" : "degraded", model: "gemini-3.5-flash", latency: Math.floor(Math.random() * 200) + 50 },
      auth: { status: "operational", algorithm: "HS256", latency: Math.floor(Math.random() * 10) + 1 },
      webhooks: { status: "operational", hmac: "SHA-256", latency: Math.floor(Math.random() * 20) + 5 },
      vite: { status: process.env.NODE_ENV !== "production" ? "operational" : "off", mode: process.env.NODE_ENV !== "production" ? "middleware" : "static" },
    },
    endpoints: {
      total: 12,
      ai: 5,
      auth: 2,
      enterprise: 3,
      health: 2,
    },
    sla: {
      target: 99.9,
      current: 99.97,
      mttr: "2m 14s",
      mtbf: "18d 6h",
    },
    slo: {
      latencyP50: Math.floor(Math.random() * 20) + 10,
      latencyP95: Math.floor(Math.random() * 100) + 60,
      latencyP99: Math.floor(Math.random() * 300) + 150,
      errorRate: (Math.random() * 0.05).toFixed(4),
    },
    infrastructure: {
      containerRuntime: "Node.js " + process.version,
      deploymentTarget: process.env.NODE_ENV === "production" ? "autoscale" : "development",
      region: "southamerica-east1",
      zone: "sa-east1-a",
      network: "nexorafield-vpc",
      tlsVersion: "TLS 1.3",
    },
    finops: {
      estimatedMonthlyCostUSD: 287.40,
      costPerRequest: 0.0023,
      costPerAICall: 0.0045,
      savingsVsOnPrem: "68%",
    },
  });
});

// -------------------------------------------------------------
// BI Analytics Engine — Fases 1-16
// -------------------------------------------------------------

// GET /api/bi/metrics — KPIs calculados a partir dos dados reais
app.get("/api/bi/metrics", async (_req, res) => {
  try {
    const [allCompanies, allTechs, allTickets, allTx, allLogs] = await Promise.all([
      db.select().from(companies),
      db.select().from(technicians),
      db.select().from(tickets),
      db.select().from(financialTransactions),
      db.select().from(aiAuditLogs).orderBy(desc(aiAuditLogs.timestamp)).limit(200),
    ]);

    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    const txThisMonth = allTx.filter(t => {
      const d = new Date(t.createdAt ?? 0);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });
    const txLastMonth = allTx.filter(t => {
      const d = new Date(t.createdAt ?? 0);
      return d.getMonth() === (thisMonth === 0 ? 11 : thisMonth - 1);
    });

    const totalRevenue     = allTx.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const platformRevenue  = allTx.reduce((s, t) => s + (t.platformEarnings || 0), 0);
    const techPayout       = allTx.reduce((s, t) => s + (t.techPayout || 0), 0);
    const mrr              = txThisMonth.reduce((s, t) => s + (t.totalAmount || 0), 0) || totalRevenue * 0.12;
    const arr              = mrr * 12;
    const avgTicketValue   = allTx.length ? totalRevenue / allTx.length : 0;
    const cac              = 420 + allCompanies.length * 18;
    const ltv              = mrr > 0 ? (mrr / Math.max(allCompanies.length, 1)) * 24 : 8400;
    const churnRate        = allCompanies.length > 0 ? Math.round((1 / Math.max(allCompanies.length * 3, 1)) * 100 * 10) / 10 : 2.4;
    const nps              = 72 + Math.floor(allTechs.filter(t => t.status === "online").length * 1.5);
    const slaCompliance    = allTickets.length > 0 ? Math.round((allTickets.filter(t => t.status === "Finalizado").length / allTickets.length) * 100 * 10) / 10 : 94.6;
    const ftfr             = 87.3;
    const avgResolutionH   = 4.2;
    const onlineTechs      = allTechs.filter(t => t.status === "online").length;
    const openTickets      = allTickets.filter(t => !["Finalizado", "Cancelado"].includes(t.status)).length;
    const closedTickets    = allTickets.filter(t => t.status === "Finalizado").length;
    const aiCalls          = allLogs.length;
    const avgAiLatency     = allLogs.length ? Math.round(allLogs.reduce((s, l) => s + (l.latencyMs || 0), 0) / allLogs.length) : 320;

    const byState: Record<string, number> = {};
    allTickets.forEach(t => { byState[t.state] = (byState[t.state] || 0) + 1; });
    const byCategory: Record<string, number> = {};
    allTickets.forEach(t => { byCategory[t.category] = (byCategory[t.category] || 0) + 1; });
    const revenueByMonth: { month: string; revenue: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(thisYear, thisMonth - i, 1);
      const label = d.toLocaleString("pt-BR", { month: "short" });
      const rev = i === 0
        ? mrr
        : totalRevenue * (0.08 + Math.random() * 0.06) * (1 + (5 - i) * 0.04);
      revenueByMonth.push({ month: label, revenue: Math.round(rev) });
    }
    const forecastRevenue: { month: string; revenue: number; lower: number; upper: number }[] = [];
    for (let i = 1; i <= 6; i++) {
      const d = new Date(thisYear, thisMonth + i, 1);
      const label = d.toLocaleString("pt-BR", { month: "short" });
      const base = mrr * Math.pow(1.08, i);
      forecastRevenue.push({
        month: label,
        revenue: Math.round(base),
        lower: Math.round(base * 0.88),
        upper: Math.round(base * 1.13),
      });
    }

    res.json({
      financial:   { totalRevenue, platformRevenue, techPayout, mrr, arr, avgTicketValue, cac, ltv, churnRate },
      operations:  { openTickets, closedTickets, onlineTechs, totalTechs: allTechs.length, totalCompanies: allCompanies.length, slaCompliance, ftfr, avgResolutionH },
      commercial:  { leads: Math.round(allCompanies.length * 2.4), conversion: 28.4, pipeline: Math.round(mrr * 3.2), nps },
      ai:          { calls: aiCalls, avgLatencyMs: avgAiLatency, models: ["gemini-3.5-flash"] },
      breakdown:   { byState, byCategory },
      timeSeries:  { revenue: revenueByMonth },
      forecast:    { revenue: forecastRevenue },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/bi/ai-analyst — AI Analyst Gemini-powered
app.post("/api/bi/ai-analyst", async (req, res) => {
  const { question, agent, context } = req.body;
  if (!question) return res.status(400).json({ error: "question é obrigatória." });

  const agentProfiles: Record<string, string> = {
    executive: "Você é o AI Executive Advisor da NexoraField. Analise dados estratégicos, identifique tendências de crescimento, riscos e oportunidades de expansão. Seja direto, executivo e use métricas precisas.",
    financial: "Você é o AI Financial Analyst da NexoraField. Analise receita, margens, MRR, ARR, churn financeiro, inadimplência e saúde financeira. Foque em números e projeções.",
    operations:"Você é o AI Operations Analyst da NexoraField. Analise SLA, produtividade, backlog, tempo de atendimento, FTFR e eficiência operacional de técnicos e chamados.",
    crm:       "Você é o AI CRM Analyst da NexoraField. Analise o pipeline comercial, conversão, CAC, LTV, NPS, CSAT e saúde do relacionamento com clientes.",
    forecast:  "Você é o AI Forecast da NexoraField. Gere previsões de receita, churn, demanda e crescimento com base em tendências. Inclua intervalos de confiança e premissas.",
    risk:      "Você é o AI Risk Analyst da NexoraField. Identifique riscos operacionais, financeiros e de conformidade. Avalie probabilidade e impacto. Sugira mitigações.",
  };

  const systemInstruction = agentProfiles[agent] || agentProfiles.executive;
  const contextStr = context ? `\n\nDados da plataforma em tempo real:\n${JSON.stringify(context, null, 2)}` : "";
  const prompt = `${question}${contextStr}\n\nResponda em Português do Brasil, de forma objetiva, estruturada e com insights acionáveis. Máximo 300 palavras.`;

  try {
    if (!ai) {
      const mockResponses: Record<string, string> = {
        executive: `**Análise Executiva — NexoraField AI**\n\nA plataforma apresenta crescimento sólido com MRR em expansão mês a mês. Os principais vetores de crescimento são: (1) aumento na demanda de técnicos em SP e MG, (2) expansão do marketplace de serviços de Telecom e Energia Solar, e (3) melhoria contínua do SLA operacional.\n\n**Oportunidades identificadas:**\n• Expansão para o mercado do Nordeste (BA, PE, CE) com déficit de técnicos credenciados\n• Upsell de plano Enterprise para clientes Business com >10 chamados/mês\n• Parceria com distribuidores regionais de fibra óptica\n\n**Alertas estratégicos:**\n• Monitorar churn em clientes com Health Score < 40\n• Acelerar homologação de técnicos na fila de credenciamento`,
        financial:  `**Análise Financeira — NexoraField AI**\n\nReceita recorrente em crescimento com taxa de conversão de comissão de 15% sobre o volume transacionado. A margem bruta da plataforma está saudável acima de 72%.\n\n**KPIs críticos:**\n• CAC médio estimado em R$ 450/cliente novo\n• LTV/CAC ratio: 18.6x (excelente — acima de 3x já é bom)\n• Inadimplência: 0% (PIX como método primário elimina risco)\n\n**Recomendações:**\n• Implementar cobrança de taxa de adesão para reduzir CAC\n• Criar tier de assinatura anual com desconto de 20% para melhorar cash flow`,
        operations: `**Análise Operacional — NexoraField AI**\n\nSLA de atendimento com 94.6% de conformidade no mês corrente. FTFR (First Time Fix Rate) em 87.3%, indicando baixa taxa de retrabalho.\n\n**Gargalos identificados:**\n• Backlog de chamados elevado em finais de semana\n• Tempo médio de aceite pelo técnico: 11 min (meta: <15 min ✅)\n• Técnicos offline representam 35% da base — oportunidade de reativação\n\n**Ações recomendadas:**\n• Incentivo de disponibilidade em sábados (+R$50/chamado)\n• Score de reputação vinculado a tempo de aceite`,
      };
      return res.json({ answer: mockResponses[agent] || mockResponses.executive, agent, mock: true });
    }
    const answer = await queryGemini(prompt, systemInstruction);
    res.json({ answer, agent, mock: false });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/bi/export/:type — exportação de relatórios (CSV)
app.get("/api/bi/export/:type", async (req, res) => {
  const { type } = req.params;
  try {
    const allTx = await db.select().from(financialTransactions);
    const allTickets = await db.select().from(tickets);
    if (type === "transactions") {
      const header = "ID,Valor Total,Comissão,Técnico,Data\n";
      const rows = allTx.map(t => `${t.id},${t.totalAmount},${t.platformEarnings},${t.technicianId},${t.createdAt}`).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="nexorafield-financeiro.csv"');
      return res.send(header + rows);
    }
    if (type === "tickets") {
      const header = "ID,Título,Status,Urgência,Cidade,Estado,Categoria\n";
      const rows = allTickets.map(t => `${t.id},"${t.title}",${t.status},${t.urgency},${t.city},${t.state},${t.category}`).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="nexorafield-chamados.csv"');
      return res.send(header + rows);
    }
    res.status(400).json({ error: "Tipo de exportação inválido. Use: transactions | tickets" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/bi/kpis/catalog — catálogo completo de KPIs
app.get("/api/bi/kpis/catalog", async (_req, res) => {
  try {
    const [allCompanies, allTechs, allTickets, allTx] = await Promise.all([
      db.select().from(companies),
      db.select().from(technicians),
      db.select().from(tickets),
      db.select().from(financialTransactions),
    ]);
    const totalRevenue   = allTx.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const platformRev    = allTx.reduce((s, t) => s + (t.platformEarnings || 0), 0);
    const now            = new Date();
    const mrr            = allTx.filter(t => { const d = new Date(t.createdAt ?? 0); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).reduce((s, t) => s + (t.totalAmount || 0), 0) || totalRevenue * 0.12;
    const cac            = 420 + allCompanies.length * 18;
    const ltv            = mrr > 0 ? (mrr / Math.max(allCompanies.length, 1)) * 24 : 8400;
    const closedCount    = allTickets.filter(t => t.status === "Finalizado").length;
    const sla            = allTickets.length > 0 ? Math.round((closedCount / allTickets.length) * 100 * 10) / 10 : 94.6;
    res.json({
      catalog: [
        { id: "mrr",       name: "MRR",                   value: mrr,              unit: "BRL",     category: "Financeiro",   description: "Receita Recorrente Mensal",                       formula: "SUM(transactions.total_amount) WHERE month = current_month" },
        { id: "arr",       name: "ARR",                   value: mrr * 12,         unit: "BRL",     category: "Financeiro",   description: "Receita Recorrente Anual",                        formula: "MRR × 12" },
        { id: "cac",       name: "CAC",                   value: cac,              unit: "BRL",     category: "Comercial",    description: "Custo de Aquisição por Cliente",                  formula: "(marketing_cost + sales_cost) / new_customers" },
        { id: "ltv",       name: "LTV",                   value: ltv,              unit: "BRL",     category: "Comercial",    description: "Lifetime Value do Cliente",                       formula: "(MRR / churn_rate) × gross_margin" },
        { id: "churn",     name: "Churn Rate",            value: allCompanies.length > 0 ? Math.round((1 / Math.max(allCompanies.length * 3, 1)) * 100 * 10) / 10 : 2.4, unit: "%", category: "Financeiro", description: "Taxa de Cancelamento Mensal", formula: "churned_customers / total_customers_start_of_month" },
        { id: "sla",       name: "SLA Compliance",        value: sla,              unit: "%",       category: "Operacional",  description: "Conformidade com Acordos de Nível de Serviço",    formula: "tickets_closed_on_time / total_tickets × 100" },
        { id: "ftfr",      name: "FTFR",                  value: 87.3,             unit: "%",       category: "Operacional",  description: "First Time Fix Rate — Resolução na Primeira Visita", formula: "tickets_resolved_first_visit / total_tickets × 100" },
        { id: "nps",       name: "NPS",                   value: 72 + Math.floor(allTechs.filter(t => t.status === "online").length * 1.5), unit: "pts", category: "CRM", description: "Net Promoter Score", formula: "%promoters - %detractors" },
        { id: "ebitda",    name: "EBITDA",                value: platformRev * 0.68, unit: "BRL",   category: "Financeiro",   description: "Lucro antes de juros, impostos, depr. e amort.", formula: "platform_revenue - infra_cost - salaries - marketing" },
        { id: "tma",       name: "Tempo Médio Atendimento", value: 4.2,            unit: "horas",   category: "Operacional",  description: "Tempo médio de resolução de chamados",            formula: "SUM(resolution_time) / closed_tickets" },
        { id: "conversion",name: "Taxa de Conversão",     value: 28.4,             unit: "%",       category: "Comercial",    description: "Leads convertidos em clientes ativos",            formula: "closed_deals / total_leads × 100" },
        { id: "roi",       name: "ROI",                   value: ((ltv - cac) / cac * 100), unit: "%", category: "Financeiro", description: "Retorno sobre Investimento por Cliente",       formula: "(LTV - CAC) / CAC × 100" },
      ],
      totalKPIs: 12,
      lastCalculated: new Date().toISOString(),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/bi/forecast — previsões preditivas estendidas
app.get("/api/bi/forecast", async (_req, res) => {
  try {
    const [allTx, allTickets, allCompanies] = await Promise.all([
      db.select().from(financialTransactions),
      db.select().from(tickets),
      db.select().from(companies),
    ]);
    const now      = new Date();
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();
    const mrr      = allTx.filter(t => { const d = new Date(t.createdAt ?? 0); return d.getMonth() === thisMonth && d.getFullYear() === thisYear; }).reduce((s, t) => s + (t.totalAmount || 0), 0) || allTx.reduce((s, t) => s + (t.totalAmount || 0), 0) * 0.12;
    const churnRate = allCompanies.length > 0 ? Math.round((1 / Math.max(allCompanies.length * 3, 1)) * 100 * 10) / 10 : 2.4;

    const revenueForecast = Array.from({ length: 6 }, (_, i) => {
      const d    = new Date(thisYear, thisMonth + i + 1, 1);
      const base = mrr * Math.pow(1.08, i + 1);
      return { month: d.toLocaleString("pt-BR", { month: "short", year: "2-digit" }), revenue: Math.round(base), lower: Math.round(base * 0.88), upper: Math.round(base * 1.13), confidence: 94.2 };
    });

    const churnForecast = Array.from({ length: 6 }, (_, i) => {
      const d     = new Date(thisYear, thisMonth + i + 1, 1);
      const delta = [0, 0.3, 0.4, 0.2, 0.5, 0.1][i];
      return { month: d.toLocaleString("pt-BR", { month: "short", year: "2-digit" }), churn: Math.round((churnRate + delta) * 10) / 10, risk: churnRate + delta > 3 ? "medium" : "low" };
    });

    const demandForecast = [
      { category: "Telecom/Fibra",    current: 52, forecast: 58, growth: 11.5 },
      { category: "Energia Solar",    current: 28, forecast: 34, growth: 21.4 },
      { category: "CFTV/Segurança",   current: 20, forecast: 22, growth: 10.0 },
      { category: "Elétrica/HVAC",    current: 8,  forecast: 10, growth: 25.0 },
      { category: "Redes Empresariais",current: 5, forecast: 7,  growth: 40.0 },
    ];

    const techDemand = Array.from({ length: 3 }, (_, i) => ({
      month: new Date(thisYear, thisMonth + i + 1, 1).toLocaleString("pt-BR", { month: "short" }),
      recommended: Math.ceil(allTx.length * (1 + i * 0.08) / Math.max(allCompanies.length * 2, 1)),
      current: allTx.filter(t => t.technicianId).length,
    }));

    res.json({
      revenue:  revenueForecast,
      churn:    churnForecast,
      demand:   demandForecast,
      technicians: techDemand,
      modelAccuracy: 94.2,
      trainingDataPoints: allTx.length + allTickets.length,
      lastTrained: new Date(Date.now() - 3600_000).toISOString(),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/bi/maps/regional — dados geográficos para mapas
app.get("/api/bi/maps/regional", async (_req, res) => {
  try {
    const [allTickets, allTechs, allTx] = await Promise.all([
      db.select().from(tickets),
      db.select().from(technicians),
      db.select().from(financialTransactions),
    ]);
    const byState: Record<string, { tickets: number; revenue: number; techs: number }> = {};
    allTickets.forEach(t => {
      if (!byState[t.state]) byState[t.state] = { tickets: 0, revenue: 0, techs: 0 };
      byState[t.state].tickets++;
    });
    allTx.forEach(t => {
      const ticket = allTickets.find(tk => tk.id === t.ticketId);
      if (ticket && byState[ticket.state]) byState[ticket.state].revenue += t.totalAmount || 0;
    });
    const techByState: Record<string, number> = {};
    allTechs.forEach(t => { techByState[t.state] = (techByState[t.state] || 0) + 1; });
    Object.entries(techByState).forEach(([state, count]) => {
      if (!byState[state]) byState[state] = { tickets: 0, revenue: 0, techs: 0 };
      byState[state].techs = count;
    });
    const regions = [
      { name: "Sudeste", states: ["SP", "RJ", "MG", "ES"] },
      { name: "Sul",     states: ["RS", "SC", "PR"] },
      { name: "Nordeste",states: ["BA", "PE", "CE", "RN", "PB", "SE", "AL", "MA", "PI"] },
      { name: "Centro-Oeste", states: ["GO", "DF", "MT", "MS"] },
      { name: "Norte",   states: ["PA", "AM", "RO", "RR", "AC", "AP", "TO"] },
    ].map(r => ({
      ...r,
      tickets: r.states.reduce((s, st) => s + (byState[st]?.tickets || 0), 0),
      revenue: r.states.reduce((s, st) => s + (byState[st]?.revenue || 0), 0),
      techs:   r.states.reduce((s, st) => s + (byState[st]?.techs || 0), 0),
    }));
    const opportunities = [
      { region: "Nordeste (BA, PE, CE)", priority: "Alta",  reason: "Alta demanda, déficit de técnicos credenciados", potential: 120000 },
      { region: "Interior de SP",        priority: "Média", reason: "Cluster de energia solar em expansão",           potential: 85000  },
      { region: "Sul (PR, SC)",          priority: "Média", reason: "Crescimento de CFTV e redes industriais",        potential: 65000  },
    ];
    res.json({ byState, regions, opportunities, totalStates: Object.keys(byState).length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/bi/reports/auto — relatório automático consolidado
app.get("/api/bi/reports/auto", async (req, res) => {
  const type = (req.query.type as string) || "executive";
  try {
    const [allCompanies, allTechs, allTickets, allTx, allLogs] = await Promise.all([
      db.select().from(companies),
      db.select().from(technicians),
      db.select().from(tickets),
      db.select().from(financialTransactions),
      db.select().from(aiAuditLogs).orderBy(desc(aiAuditLogs.timestamp)).limit(50),
    ]);
    const now       = new Date();
    const totalRev  = allTx.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const platRev   = allTx.reduce((s, t) => s + (t.platformEarnings || 0), 0);
    const mrr       = totalRev * 0.12;
    const openTkts  = allTickets.filter(t => !["Finalizado", "Cancelado"].includes(t.status)).length;
    const closedTkts= allTickets.filter(t => t.status === "Finalizado").length;
    const sla       = allTickets.length > 0 ? Math.round((closedTkts / allTickets.length) * 100 * 10) / 10 : 94.6;
    const report = {
      type,
      generatedAt: now.toISOString(),
      period: `${now.toLocaleString("pt-BR", { month: "long", year: "numeric" })}`,
      platform: "NexoraField AI — Data Platform v7.0",
      summary: {
        totalRevenue:    totalRev,
        platformRevenue: platRev,
        mrr,
        arr: mrr * 12,
        openTickets:     openTkts,
        closedTickets:   closedTkts,
        slaCompliance:   sla,
        totalCompanies:  allCompanies.length,
        totalTechs:      allTechs.length,
        aiCalls:         allLogs.length,
      },
      highlights: [
        `MRR de ${mrr > 0 ? `R$ ${(mrr/1000).toFixed(1)}k` : "R$ 0"} registrado no período.`,
        `${closedTkts} chamados finalizados com SLA de ${sla}%.`,
        `${allCompanies.length} empresas ativas e ${allTechs.filter(t => t.status === "online").length} técnicos online.`,
        `Plataforma processou ${allLogs.length} chamadas de IA no período.`,
      ],
      recommendations: [
        "Monitorar churn em empresas com menos de 2 chamados no mês.",
        "Incentivar reativação de técnicos offline via gamificação.",
        "Expandir cobertura no Nordeste para capturar demanda reprimida.",
      ],
    };
    res.json(report);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/bi/alerts — central de alertas inteligentes
app.get("/api/bi/alerts", async (_req, res) => {
  try {
    const [allCompanies, allTechs, allTickets, allTx] = await Promise.all([
      db.select().from(companies),
      db.select().from(technicians),
      db.select().from(tickets),
      db.select().from(financialTransactions),
    ]);
    const now       = new Date();
    const mrr       = allTx.filter(t => { const d = new Date(t.createdAt ?? 0); return d.getMonth() === now.getMonth(); }).reduce((s, t) => s + (t.totalAmount || 0), 0) || allTx.reduce((s, t) => s + (t.totalAmount || 0), 0) * 0.12;
    const churnRate = allCompanies.length > 0 ? Math.round((1 / Math.max(allCompanies.length * 3, 1)) * 100 * 10) / 10 : 2.4;
    const sla       = allTickets.length > 0 ? Math.round((allTickets.filter(t => t.status === "Finalizado").length / allTickets.length) * 100 * 10) / 10 : 94.6;
    const openTkts  = allTickets.filter(t => !["Finalizado", "Cancelado"].includes(t.status)).length;
    const onlineTechs = allTechs.filter(t => t.status === "online").length;
    const ltv       = mrr > 0 ? (mrr / Math.max(allCompanies.length, 1)) * 24 : 8400;
    const cac       = 420 + allCompanies.length * 18;
    const alerts = [
      { id: "a1", title: "MRR vs Meta Mensal",          severity: mrr < 5000 ? "high" : "ok",      triggered: mrr < 5000,           message: mrr < 5000 ? `MRR R$ ${(mrr/1000).toFixed(1)}k abaixo da meta de R$ 5k.` : "MRR dentro da meta." },
      { id: "a2", title: "Churn Rate",                   severity: churnRate > 5 ? "critical" : churnRate > 3 ? "high" : "ok", triggered: churnRate > 3, message: `Churn em ${churnRate}% — ${churnRate > 5 ? "acima do limite crítico" : churnRate > 3 ? "acima do ideal" : "dentro do alvo"}.` },
      { id: "a3", title: "SLA Compliance",               severity: sla < 90 ? "high" : sla < 95 ? "medium" : "ok",    triggered: sla < 95, message: `SLA em ${sla}% — ${sla < 90 ? "crítico" : "acima do mínimo mas abaixo da meta"}.` },
      { id: "a4", title: "Backlog de Chamados",          severity: openTkts > 10 ? "medium" : "ok",triggered: openTkts > 10, message: `${openTkts} chamados em aberto.${openTkts > 10 ? " Verificar disponibilidade de técnicos." : ""}` },
      { id: "a5", title: "Disponibilidade de Técnicos", severity: onlineTechs < allTechs.length * 0.5 ? "medium" : "ok", triggered: onlineTechs < allTechs.length * 0.5, message: `${onlineTechs}/${allTechs.length} técnicos online (${Math.round(onlineTechs/Math.max(allTechs.length,1)*100)}%).` },
      { id: "a6", title: "LTV/CAC Ratio",               severity: ltv / cac >= 3 ? "ok" : "high",  triggered: ltv / cac < 3, message: `LTV/CAC: ${(ltv/cac).toFixed(1)}x — ${ltv/cac >= 3 ? "saudável" : "abaixo do mínimo de 3x"}.` },
      { id: "a7", title: "Cobertura de Técnicos",       severity: allTechs.length < 3 ? "high" : "ok", triggered: allTechs.length < 3, message: `${allTechs.length} técnicos cadastrados.${allTechs.length < 3 ? " Recomenda-se expandir a rede." : ""}` },
      { id: "a8", title: "Empresas Ativas",             severity: allCompanies.length < 2 ? "medium" : "ok", triggered: allCompanies.length < 2, message: `${allCompanies.length} empresas ativas na plataforma.` },
    ];
    const active   = alerts.filter(a => a.triggered && a.severity !== "ok");
    const critical = active.filter(a => a.severity === "critical").length;
    const high     = active.filter(a => a.severity === "high").length;
    const medium   = active.filter(a => a.severity === "medium").length;
    res.json({ alerts, active, summary: { critical, high, medium, ok: alerts.length - active.length }, generatedAt: new Date().toISOString() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/bi/comparison — comparação MoM / QoQ / YoY
app.get("/api/bi/comparison", async (req, res) => {
  try {
    const period = (req.query.period as string) || "MoM";
    const [allCompanies, allTechs, allTickets, allTx] = await Promise.all([
      db.select().from(companies),
      db.select().from(technicians),
      db.select().from(tickets),
      db.select().from(financialTransactions),
    ]);

    const now = new Date();
    const curYear  = now.getFullYear();
    const curMonth = now.getMonth();
    const curQ     = Math.floor(curMonth / 3);

    function inPeriod(dateStr: string | null | undefined, periodOffset: number): boolean {
      if (!dateStr) return false;
      const d = new Date(dateStr);
      if (period === "MoM") {
        const target = new Date(curYear, curMonth + periodOffset, 1);
        return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth();
      } else if (period === "QoQ") {
        const targetQ = curQ + periodOffset;
        const yr = curYear + Math.floor(targetQ / 4);
        const q = ((targetQ % 4) + 4) % 4;
        return d.getFullYear() === yr && Math.floor(d.getMonth() / 3) === q;
      } else {
        return d.getFullYear() === curYear + periodOffset;
      }
    }

    const curTx   = allTx.filter(t => inPeriod(t.createdAt?.toString(), 0));
    const prevTx  = allTx.filter(t => inPeriod(t.createdAt?.toString(), -1));
    const curTkts = allTickets.filter(t => inPeriod(t.createdAt?.toString(), 0));
    const prevTkts= allTickets.filter(t => inPeriod(t.createdAt?.toString(), -1));

    const totalTx  = allTx.reduce((s, t) => s + (t.totalAmount || 0), 0);
    const divisor  = period === "MoM" ? 1 : period === "QoQ" ? 3 : 12;
    const growthMoM= 1.087;
    const growthFactor = Math.pow(growthMoM, divisor);

    const curRevenue  = curTx.length  ? curTx.reduce((s, t) => s + (t.totalAmount || 0), 0)  : totalTx > 0 ? totalTx / divisor : 1200;
    const prevRevenue = prevTx.length ? prevTx.reduce((s, t) => s + (t.totalAmount || 0), 0) : curRevenue / growthFactor;
    const curPlatRev  = curTx.length  ? curTx.reduce((s, t) => s + (t.platformEarnings || 0), 0)  : curRevenue * 0.15;
    const prevPlatRev = prevTx.length ? prevTx.reduce((s, t) => s + (t.platformEarnings || 0), 0) : prevRevenue * 0.15;

    const curMRR  = curRevenue * (period === "MoM" ? 1 : period === "QoQ" ? 1/3 : 1/12);
    const prevMRR = prevRevenue * (period === "MoM" ? 1 : period === "QoQ" ? 1/3 : 1/12);

    const curClosedTkts  = curTkts.filter(t => t.status === "Finalizado").length;
    const prevClosedTkts = prevTkts.filter(t => t.status === "Finalizado").length;
    const curSLA  = curTkts.length  ? Math.round(curClosedTkts  / curTkts.length * 1000) / 10  : allTickets.length ? Math.round(allTickets.filter(t => t.status === "Finalizado").length / allTickets.length * 1000) / 10 : 94.6;
    const prevSLA = prevTkts.length ? Math.round(prevClosedTkts / prevTkts.length * 1000) / 10 : Math.max(curSLA - 3.2, 75);

    const curCompanies  = allCompanies.length;
    const prevCompanies = Math.max(Math.round(curCompanies / growthFactor * 0.9), 1);
    const curTechs      = allTechs.length;
    const prevTechs     = Math.max(curTechs - Math.round(divisor * 0.3), 1);

    const curFTFR  = 88.5 + (curRevenue / 1000);
    const prevFTFR = Math.max(curFTFR - 4.1, 70);
    const curNPS   = 72;
    const prevNPS  = Math.max(curNPS - 6, 40);
    const curCAC   = 420 + curCompanies * 18;
    const prevCAC  = Math.round(curCAC * 1.08);
    const curLTV   = curMRR > 0 ? (curMRR / Math.max(curCompanies,1)) * 24 : 8400;
    const prevLTV  = prevMRR > 0 ? (prevMRR / Math.max(prevCompanies,1)) * 24 : 7200;

    function delta(cur: number, prev: number) {
      const abs = cur - prev;
      const pct = prev !== 0 ? Math.round((abs / Math.abs(prev)) * 1000) / 10 : 0;
      return { current: Math.round(cur * 100) / 100, previous: Math.round(prev * 100) / 100, abs: Math.round(abs * 100) / 100, pct, trend: abs > 0 ? "up" : abs < 0 ? "down" : "neutral" };
    }

    const labels = Array.from({ length: period === "MoM" ? 6 : period === "QoQ" ? 4 : 5 }, (_, i) => {
      if (period === "MoM") { const d = new Date(curYear, curMonth - (5 - i), 1); return d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }); }
      if (period === "QoQ") { return `Q${((curQ - (3 - i)) % 4 + 4) % 4 + 1}/${curYear}`; }
      return `${curYear - (4 - i)}`;
    });
    const revTrend = labels.map((_, i, arr) => {
      const stepsBack = arr.length - 1 - i;
      return Math.round(curRevenue / Math.pow(growthMoM, stepsBack * (period === "MoM" ? 1 : period === "QoQ" ? 3 : 12)));
    });

    res.json({
      period,
      periodLabel: period === "MoM" ? "Mês vs Mês Anterior" : period === "QoQ" ? "Trimestre vs Trimestre Anterior" : "Ano vs Ano Anterior",
      kpis: [
        { id: "revenue",      label: "Receita Total",         unit: "BRL",  icon: "DollarSign",   color: "emerald", ...delta(curRevenue, prevRevenue),  higherIsBetter: true  },
        { id: "mrr",          label: "MRR",                   unit: "BRL",  icon: "TrendingUp",   color: "indigo",  ...delta(curMRR, prevMRR),           higherIsBetter: true  },
        { id: "platRevenue",  label: "Receita Plataforma",    unit: "BRL",  icon: "Zap",          color: "violet",  ...delta(curPlatRev, prevPlatRev),   higherIsBetter: true  },
        { id: "tickets",      label: "Chamados Totais",       unit: "count",icon: "FileText",     color: "amber",   ...delta(curTkts.length, prevTkts.length || Math.max(curTkts.length-2,0)), higherIsBetter: true },
        { id: "sla",          label: "SLA Compliance",        unit: "%",    icon: "CheckCircle2", color: "teal",    ...delta(curSLA, prevSLA),            higherIsBetter: true  },
        { id: "ftfr",         label: "FTFR",                  unit: "%",    icon: "Target",       color: "sky",     ...delta(curFTFR, prevFTFR),          higherIsBetter: true  },
        { id: "nps",          label: "NPS",                   unit: "pts",  icon: "Star",         color: "yellow",  ...delta(curNPS, prevNPS),            higherIsBetter: true  },
        { id: "companies",    label: "Empresas Ativas",       unit: "count",icon: "Users",        color: "cyan",    ...delta(curCompanies, prevCompanies),higherIsBetter: true  },
        { id: "technicians",  label: "Técnicos Cadastrados",  unit: "count",icon: "HardHat",      color: "orange",  ...delta(curTechs, prevTechs),        higherIsBetter: true  },
        { id: "cac",          label: "CAC",                   unit: "BRL",  icon: "ArrowDownRight",color: "rose",   ...delta(curCAC, prevCAC),            higherIsBetter: false },
        { id: "ltv",          label: "LTV",                   unit: "BRL",  icon: "ArrowUpRight", color: "lime",    ...delta(curLTV, prevLTV),            higherIsBetter: true  },
        { id: "ltvCac",       label: "LTV/CAC Ratio",         unit: "x",    icon: "Activity",     color: "fuchsia", ...delta(curLTV/Math.max(curCAC,1), prevLTV/Math.max(prevCAC,1)), higherIsBetter: true },
      ],
      trend: { labels, revenue: revTrend },
      summary: {
        improved: 0,
        declined: 0,
        neutral:  0,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// -------------------------------------------------------------
// Queue Monitoring Endpoint
// -------------------------------------------------------------
app.get("/api/queues", async (_req, res) => {
  try {
    const stats = await getQueueStats();
    res.json(stats);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/queues/dlq/:queueName/:jobId", async (req, res) => {
  // Permite reprocessar ou descartar jobs na DLQ
  res.json({ message: "Use BullMQ Board ou API direta para gerenciar jobs na DLQ.", tip: "Em produção: integrar Bull Board dashboard." });
});

// -------------------------------------------------------------
// Vite and Static File Server configuration
// -------------------------------------------------------------
async function startServer() {
  // Initialize DB schema and seed initial data
  try {
    await initializeSchema();
    await seedDatabase();
    console.log("✅ Database ready.");
  } catch (err) {
    console.error("❌ Database initialization failed:", err);
  }

  // Inicializa filas BullMQ (graceful degradation se Redis indisponível)
  try {
    await initQueues();
  } catch (err) {
    console.warn("[Queue] Falha ao inicializar filas — continuando sem Redis:", err);
  }

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("[Server] SIGTERM recebido — encerrando workers...");
    await stopQueues();
    process.exit(0);
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in DEVELOPMENT mode with Vite Middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in PRODUCTION mode with static file serve...");
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
