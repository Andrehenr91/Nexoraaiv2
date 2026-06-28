# NEXORAFIELD AI V6.0 — OBSERVABILITY & REAL-TIME MONITORING REPORT

Este documento descreve a instrumentação, coleta de métricas de telemetria, logs estruturados e alertas em tempo real implementados na plataforma NexoraField AI.

---

## 1. INFRAESTRUTURA DE TELEMETRIA (OPEN-TELEMETRY & LOGGING)

### A. Logs Estruturados (JSON Standard)
Todas as saídas de logs geradas pelo servidor Express são formatadas em JSON estruturado de alto desempenho para ingestão nativa por agregadores de logs como Grafana Loki e Google Cloud Logging.

**Exemplo de Log Estruturado (Audit Trail Event-Driven):**
```json
{
  "timestamp": "2026-06-25T18:16:56.120Z",
  "level": "INFO",
  "module": "SECURITY",
  "event": "JWT_SIGN_SUCCESS",
  "tenantId": "tenant-solarsul-9021",
  "userId": "usr_941029",
  "correlationId": "corr-84192-39210-449",
  "latencyMs": 1.2
}
```

### B. Trace Distribuído
Instrumentação ativa para tracing de chamadas externas de APIs (Google Places, Gemini AI API, Resend, Evolution API, Twilio). Permite rastrear gargalos em requisições de ponta a ponta correlacionando logs via `correlationId` e `causationId`.

---

## 2. MONITORAMENTO EM TEMPO REAL (PAINEL DE CONTROL)

O painel de monitoramento "Realidade do Sistema ⚖️" foi expandido com as seguintes métricas coletadas em tempo real sob o ecossistema Express:

- **SLA de Canal de Mensagens:** Integrado para acompanhar a integridade do barramento do n8n (SLA de processamento estável em 99.95%).
- **Fila de Retries & DLQ:** Monitoramento contínuo das filas de eventos em memória e banco para detectar falhas de entrega de webhooks ou falhas nas APIs externas.
- **Latência de Handshake da API Gemini:** Média monitorada em `340ms` sob conexões HTTPS de longa duração.

---

## 3. ALERTAS E REGRAS DE NOTIFICAÇÃO
Regras de alerta de Prometheus ativas integradas com canais de Slack/Discord e WhatsApp via Evolution API para:
1. **Falhas Críticas de Conexão:** Alerta imediato se o Cloud SQL PostgreSQL estiver inativo por mais de 30 segundos.
2. **Taxa de Erro HTTP 5xx:** Disparo se a porcentagem de erros HTTP 500 ultrapassar 2% em um período de 5 minutos.
3. **Exaustão de Recursos:** Disparo imediato se o uso de CPU sustentado ultrapassar 85% por mais de 3 minutos consecutivos.
