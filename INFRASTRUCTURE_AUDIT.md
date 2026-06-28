# INFRASTRUCTURE_AUDIT.md — NexoraField AI v7.0
**Gerado em:** 2026-06-26 | **Auditado por:** Comitê Executivo de Arquitetura Cloud Enterprise

---

## 1. VISÃO GERAL DA INFRAESTRUTURA ATUAL

| Componente | Estado Atual | Estado Alvo |
|---|---|---|
| Runtime | Node.js 20 + Vite (monolito) | Kubernetes GKE multi-container |
| Banco de Dados | Mock em memória (data.ts) | Cloud SQL PostgreSQL 15 HA |
| Cache | Nenhum | Memorystore Redis 7 (Sentinel) |
| Filas | Nenhuma | BullMQ + Cloud Tasks |
| Storage | Nenhum | Cloud Storage multi-region + CDN |
| CI/CD | Manual | GitHub Actions → GKE (Canary/Blue-Green) |
| Observabilidade | Console logs | OpenTelemetry + Prometheus + Grafana |
| Segurança | JWT básico | Cloud Armor + WAF + Secret Manager |
| Escalabilidade | Single instance | HPA 2–20 réplicas auto |

---

## 2. SERVIÇOS EXISTENTES

### 2.1 Backend API (Express + Node.js)
- **Porta:** 5000
- **Modo dev:** Vite middleware (HMR)
- **Modo prod:** Serve `dist/` estático
- **Endpoints:** 12 rotas (5 IA, 2 Auth, 3 Enterprise, 2 Health)

### 2.2 Workers de IA (Gemini API)
- `POST /api/ai/classify` — Classificação automática de chamados
- `POST /api/ai/match` — Matching técnico inteligente (Haversine + skills)
- `POST /api/ai/summarize` — Relatório técnico formal (Markdown)
- `POST /api/ai/fraud-check` — Detecção de fraude GPS/tempo
- `POST /api/ai/assist` — Copiloto multi-role (Admin/Empresa/Técnico)

### 2.3 Frontend SPA (React 19 + Vite + Tailwind 4)
- Portal Admin (gestão global, BI, compliance)
- Portal Empresa (chamados, contratos, técnicos)
- Portal Técnico (agenda, checklist, relatórios)
- Portal Comercial (CRM, prospecção, leads)
- Portal Enterprise (webhooks, multi-tenant)

---

## 3. DEPENDÊNCIAS CRÍTICAS

| Dependência | Versão | Criticidade |
|---|---|---|
| @google/genai | ^2.4.0 | CRÍTICA — IA core |
| express | ^4.21.2 | CRÍTICA — API |
| jsonwebtoken | ^9.0.3 | ALTA — Autenticação |
| react | ^19.0.1 | ALTA — Frontend |
| vite | ^6.2.3 | MÉDIA — Build |
| dotenv | ^17.2.3 | MÉDIA — Config |

---

## 4. VARIÁVEIS DE AMBIENTE

| Variável | Obrigatória | Local atual | Destino |
|---|---|---|---|
| `GEMINI_API_KEY` | SIM | .env / Secrets panel | GCP Secret Manager |
| `JWT_SECRET` | SIM | .env / código | GCP Secret Manager |
| `PORT` | NÃO | 5000 (default) | ConfigMap K8s |
| `NODE_ENV` | NÃO | development | ConfigMap K8s |
| `DATABASE_URL` | FUTURO | — | GCP Secret Manager |
| `REDIS_URL` | FUTURO | — | GCP Secret Manager |

---

## 5. PONTOS ÚNICOS DE FALHA (SPOF)

| SPOF | Impacto | Mitigação |
|---|---|---|
| Instância única Node.js | Indisponibilidade total | HPA min=2 + anti-affinity |
| Sem banco persistente | Perda de dados em restart | Cloud SQL HA + backup PITR |
| GEMINI_API_KEY única | IA parada sem fallback estruturado | Fallback rule-based implementado |
| Sem rate limiting | Abuso de API / custos IA | Cloud Armor + Express rate-limit |
| JWT_SECRET hardcoded | Falha de segurança crítica | GCP Secret Manager |

---

## 6. GARGALOS IDENTIFICADOS

1. **IA síncrona:** Chamadas Gemini bloqueiam o thread — mover para workers assíncronos
2. **Sem cache:** Toda resposta recalculada — Redis para respostas frequentes
3. **Monolito:** Frontend e backend no mesmo processo — separar containers
4. **Sem connection pool:** Futuro PostgreSQL precisará PgBouncer
5. **Logs apenas console:** Sem estruturação, correlação ou retenção

---

## 7. SCORE DE MATURIDADE

| Dimensão | Score Atual | Score Alvo |
|---|---|---|
| Disponibilidade | 3/10 | 9/10 |
| Escalabilidade | 2/10 | 9/10 |
| Observabilidade | 2/10 | 9/10 |
| Segurança | 5/10 | 9/10 |
| Recuperação | 1/10 | 9/10 |
| **TOTAL** | **13/50** | **45/50** |
