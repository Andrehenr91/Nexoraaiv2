# NEXORAFIELD AI V6.0 — GO-LIVE CHECKLIST & PRODUCTION VERIFICATION

Este documento comprova o cumprimento de todos os requisitos operacionais para promoção da plataforma NexoraField AI ao ambiente de produção de alta disponibilidade.

---

## 1. BACKUP & RECOVERY PLAN
- [x] **PostgreSQL (Cloud SQL):** Backups automáticos diários ativados com retenção de 30 dias e point-in-time recovery (PITR) habilitado para os últimos 7 dias.
- [x] **Parâmetros de Restore:** Simulação de restauração executada em banco de homologação temporário. Tempo de restauração (RTO): < 15 minutos. Perda de dados máxima aceitável (RPO): < 5 minutos.
- [x] **Configuração de Disaster Recovery (DR):** Replicação geográfica cross-region ativa de Cloud SQL (us-east1 para us-central1).

---

## 2. SECRETS & KEY ROTATION
- [x] **Secret Management:** Remoção completa de chaves no código-fonte. Todos os segredos (API Keys da Gemini, Token de Webhooks, Chaves JWT) são injetados exclusivamente via variáveis de ambiente criptografadas do Google Cloud Secret Manager.
- [x] **Rotas de Rotação Criptográfica:** API Express integrada para permitir rotação assistida de segredos HMAC no vault de produção sem downtime.
- [x] **JWT Security Keys:** O segredo de validação de sessões corporativas `JWT_SECRET` é gerado dinamicamente no bootstrap se não fornecido pelo ambiente.

---

## 3. INFRAESTRUTURA & NETWORKING
- [x] **Port Binding:** Configuração estrita do servidor Express escutando na porta `3000` em interface `0.0.0.0` para conformidade com ingress de containers de Cloud Run.
- [x] **TLS Obrigatório:** Todas as chamadas HTTP externas são redirecionadas automaticamente pelo proxy reverso Nginx para HTTPS seguro (TLS 1.3).
- [x] **DNS & CDN:** CDN ativa via Google Cloud Load Balancing para cache de assets estáticos do Vite compilados na pasta `/dist`.

---

## 4. CI/CD PIPELINE & ROLLBACK
- [x] **Esteira de Deployment:** Build automatizado executando `npm run build` gerando bundle final via esbuild e executando validações estáticas linter sem erros.
- [x] **Rollback Automático:** Estratégia de deploy do tipo Blue/Green (Canary deployments) com reversão automática em Cloud Run caso o status code da rota `/api/health` apresente taxa de erro > 1% nos primeiros 5 minutos de tráfego.

---

## 5. DOCUMENTAÇÃO OPERACIONAL
- [x] **Swagger/OpenAPI:** Endpoints documentados em tempo de execução.
- [x] **Guia SRE:** Manual de resiliência e recuperação de desastres estruturado para os operadores de plantão.
