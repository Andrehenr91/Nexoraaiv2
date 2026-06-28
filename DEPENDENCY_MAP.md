# DEPENDENCY_MAP.md — NexoraField AI v7.0
**Mapa completo de dependências e fluxo de dados**

---

## ARQUITETURA DE SERVIÇOS

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        NexoraField AI — Fluxo de Dados                     │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌───────────────┐    HTTPS/443    ┌──────────────────┐
  │   Usuário     │ ──────────────► │  Cloud CDN       │
  │   Browser     │                 │  Cloud Armor WAF │
  └───────────────┘                 └────────┬─────────┘
                                             │
                                    ┌────────▼─────────┐
                                    │   Cloud Load     │
                                    │   Balancer       │
                                    └────────┬─────────┘
                                             │
                          ┌──────────────────▼──────────────────┐
                          │        GKE — nexorafield ns         │
                          │  ┌──────────┐  ┌──────────────────┐ │
                          │  │  nexora- │  │  nexora-         │ │
                          │  │  api     │  │  worker-ai       │ │
                          │  │  Pod ×3  │  │  Pod ×2          │ │
                          │  └────┬─────┘  └────────┬─────────┘ │
                          │       │                  │           │
                          └───────┼──────────────────┼───────────┘
                                  │                  │
               ┌──────────────────▼──┐  ┌────────────▼──────────┐
               │  Cloud SQL          │  │  Google Gemini AI      │
               │  PostgreSQL 15 HA   │  │  gemini-3.5-flash     │
               │  Primary + Replica  │  │  API externa           │
               └─────────────────────┘  └───────────────────────┘
                          │
               ┌──────────▼──────────┐
               │  Memorystore Redis  │
               │  Sentinel HA        │
               │  Cache + Queue      │
               └─────────────────────┘
```

---

## DEPENDÊNCIAS NPM — GRAFO

```
nexorafield
├── RUNTIME
│   ├── express@4.21.2          → HTTP server, routing
│   ├── @google/genai@2.4.0     → Gemini AI SDK
│   ├── jsonwebtoken@9.0.3      → JWT auth
│   ├── dotenv@17.2.3           → Env vars
│   └── crypto (native)         → HMAC webhooks
│
├── FRONTEND
│   ├── react@19.0.1            → UI framework
│   ├── react-dom@19.0.1        → DOM rendering
│   ├── motion@12.23.24         → Animations (Framer Motion)
│   ├── lucide-react@0.546.0    → Icons
│   └── tailwindcss@4.1.14      → CSS framework
│
└── BUILD
    ├── vite@6.2.3              → Dev server + bundler
    ├── @vitejs/plugin-react     → React HMR
    ├── @tailwindcss/vite        → Tailwind integration
    ├── esbuild@0.25.0           → Server bundler
    └── tsx@4.21.0              → TypeScript runner
```

---

## FLUXO DE AUTENTICAÇÃO

```
Browser → POST /api/auth/login
          │
          ▼
     Valida credenciais (mock hardcoded)
     Roles: admin | company | technician | comercial
          │
          ▼
     jwt.sign({ role, email }, JWT_SECRET, { expiresIn: '2h' })
          │
          ▼
     Bearer Token → Headers de cada requisição API
          │
          ▼
     POST /api/auth/verify → jwt.verify() → decoded payload
```

---

## FLUXO DE IA

```
Frontend → POST /api/ai/{endpoint}
           │
           ▼
       Check: GEMINI_API_KEY ?
       ┌─── SIM ────────────────────────────────────────┐
       │    GoogleGenAI.models.generateContent()         │
       │    model: gemini-3.5-flash                      │
       │    config: temperature=0.2, responseMimeType    │
       └─────────────────────────────────────────────────┘
       ┌─── NÃO ────────────────────────────────────────┐
       │    Rule-based fallback (heurísticas locais)     │
       │    Sem custo, sem latência externa              │
       └─────────────────────────────────────────────────┘
           │
           ▼
       Response JSON → Frontend
```

---

## FLUXO DE WEBHOOK

```
Evento interno → POST /api/enterprise/webhooks/fire
                 │
                 ▼
            crypto.createHmac('sha256', secret)
            .update(JSON.stringify(payload))
            .digest('hex')
                 │
                 ▼
            Header: X-NexoraField-Signature: nexora-sig=<hmac>
                 │
                 ▼
            Entrega HTTP para URL configurada pelo tenant
```

---

## COMUNICAÇÃO ENTRE SERVIÇOS (ALVO PRODUÇÃO)

| Origem | Destino | Protocolo | Autenticação |
|---|---|---|---|
| API Pod | PostgreSQL | TCP/5432 TLS | Service Account + IAM |
| API Pod | Redis | TCP/6379 TLS | AUTH password + TLS |
| API Pod | Gemini API | HTTPS/443 | API Key (Secret Manager) |
| Worker AI | Redis Queue | TCP/6379 | BullMQ |
| API Pod | Cloud Storage | HTTPS | Workload Identity |
| CI/CD | Artifact Registry | HTTPS | Service Account JSON |
| GKE | Secret Manager | HTTPS | Workload Identity |
