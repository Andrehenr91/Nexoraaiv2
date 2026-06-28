# NEXORAFIELD AI V6.0 — OPEN ISSUES & RISK MITIGATION PLAN

Este documento compila os riscos técnicos identificados pela equipe independente de auditoria, integrações parciais homologadas em sandbox e planos de mitigação operacional recomendados para garantir alta disponibilidade no Go-Live.

---

## 1. INTEGRAÇÕES EM SANDBOX & MOCK ATIVO (ESTADO REAL)

Para garantir que a plataforma não ficasse exposta a faturas não-provisionadas ou cobranças de produção durante as baterias de testes de certificação, certas integrações foram mantidas intencionalmente em ambiente de homologação ou sandbox:

### A. Gateways Financeiros (Asaas / Efí)
* **Estado:** **PARCIAL (Sandbox Ativo)**.
* **Descrição:** Geração de transações e conciliação de PIX simuladas sob barramento de webhook assinado via HMAC SHA-256 no Express backend.
* **Risco:** Requer troca de credenciais de homologação para produção nas variáveis de ambiente do Vault antes do tráfego real.
* **Mitigação:** Configuração de flag estrita de ambiente `NODE_ENV=production` e validação dupla de chaves simétricas.

### B. Twilio SMS Gateway
* **Estado:** **PARCIAL (Mock Ativo)**.
* **Descrição:** Fila de outbound simulada para disparo de SMS corporativos para técnicos.
* **Risco:** Limitação de envio sem saldo na conta Twilio.
* **Mitigação:** Alerta integrado no Painel Realidade do Sistema caso o saldo da API atinja um limite mínimo de segurança (< R$ 50,00).

---

## 2. RISCOS OPERACIONAIS & MITIGAÇÕES DE SEGURANÇA

| ID | Risco Identificado | Probabilidade / Impacto | Plano de Mitigação Operacional | Responsável |
| :--- | :--- | :--- | :--- | :--- |
| **R-01** | Exaustão de Conexões de PostgreSQL sob carga sustentada | Baixa / Alto | Pooling estrito via Drizzle ORM fixado em 20 conexões ativas simultâneas com timeout rápido de socket de 3s. | Database Architect |
| **R-02** | Latência em Chamadas externas da Gemini API | Média / Médio | Mecanismo de Cache de contexto inteligente ativo e failover para modelos locais mais rápidos caso ocorra timeout. | AI Systems Architect |
| **R-03** | Vazamento de Chaves HMAC de Webhook no n8n | Baixa / Crítico | Rotação automatizada de chaves a cada 30 dias via Secrets Manager e auditoria ativa de logs de payloads de webhook recebidos. | DevSecOps Lead |

---

## 3. AUDITORIA OPERACIONAL E TRILHA LGPD
Todo processamento de dados sensíveis na esteira de Leads do CRM passa pelo pipeline assíncrono de mascaramento irreversível via SHA-256 no backend, minimizando a exposição de dados pessoais na rede corporativa.
