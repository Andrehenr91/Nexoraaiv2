# DOCUMENTAÇÃO TÉCNICA: AUTOMAÇÃO DE PROSPECÇÃO (n8n, WEBHOOKS & CRM)
## NexoraField AI - Módulo de Expansão e Growth Engine

Esta documentação detalha a arquitetura, schemas de banco de dados, assinaturas de payloads de Webhooks e fluxos de integração necessários para automatizar a prospecção ativa de empresas (clientes SaaS) e técnicos credenciados (prestadores de serviços) utilizando a ferramenta de orquestração **n8n** conectada à plataforma **NexoraField AI**.

---

## 1. Visão Geral da Arquitetura de Prospecção

O **Growth Engine** opera conectando eventos de CRM na NexoraField AI com workflows automatizados no n8n. O n8n é responsável por receber os gatilhos (webhooks), processar enriquecimento de dados via Inteligência Artificial e coordenar o disparo multicanal através de APIs de mensageria parceiras.

```
┌─────────────────┐             ┌─────────┐             ┌─────────────────────┐
│ NexoraField AI  │ ──(Webhook)─>│   n8n   │ ──(API Call)─>│ APIs de Mensageria  │
│ (CRM / Growth)  │             │ Engine  │             │ (Whats, SMS, Email) │
└─────────────────┘             └─────────┘             └─────────────────────┘
```

---

## 2. Modelagem de Dados no CRM (Campos Obrigatórios)

Para suportar o funil de prospecção autônoma, o banco de dados do CRM deve conter campos específicos para rastrear o consentimento (LGPD), status de contato e canais preferenciais.

### 2.1. Entidade: Leads de Empresas (Clientes SaaS)
Armazena empresas potenciais para contratação do software de gerenciamento de campo.

| Campo | Tipo | Descrição | Exemplo |
| :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | Identificador único (UUID v4) | `lead_comp_9281` |
| `razao_social` | `VARCHAR(255)` | Razão social ou Nome Fantasia | `SolarSul Distribuidora Ltda` |
| `cnpj` | `VARCHAR(18)` | CNPJ para validação fiscal (opcional no funil) | `12.345.678/0001-90` |
| `email` | `VARCHAR(150)` | E-mail corporativo principal | `comercial@solarsul.com.br` |
| `telefone` | `VARCHAR(20)` | Telefone com WhatsApp cadastrado | `+5519998887766` |
| `responsavel_nome` | `VARCHAR(100)` | Nome do decisor mapeado no scraping | `Julio Cesar Camargo` |
| `responsavel_cargo` | `VARCHAR(100)` | Cargo do decisor no organograma | `Diretor de Operações` |
| `estado` | `VARCHAR(2)` | Unidade Federativa (UF) | `SP` |
| `cidade` | `VARCHAR(100)` | Município polo de atuação | `Campinas` |
| `origem` | `VARCHAR(50)` | Fonte do lead (Scraping, Google Maps, Outbound) | `Google Maps Scraper` |
| `segmento` | `VARCHAR(100)` | Categoria de serviço prestado | `Energia Solar S.A.` |
| `status_funil` | `ENUM` | Fase atual no Kanban de CRM | `Fria`, `Contatado`, `Demonstração`, `Ganho` |
| `lgpd_consent` | `BOOLEAN` | Consentimento de contato sob base legal | `TRUE` |
| `ultimo_contato` | `TIMESTAMP` | Data/hora da última automação disparada | `2026-06-25 17:40:00` |

### 2.2. Entidade: Leads de Técnicos Prestadores
Armazena profissionais autônomos ou credenciados mapeados em regiões com déficit de atendimento.

| Campo | Tipo | Descrição | Exemplo |
| :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | UUID v4 | `lead_tech_1092` |
| `nome_completo` | `VARCHAR(255)` | Nome civil do prestador | `Ricardo Mendes Silva` |
| `cpf` | `VARCHAR(14)` | Cadastro de Pessoa Física | `333.444.555-66` |
| `whatsapp` | `VARCHAR(20)` | Número de celular com DDI e DDD | `+5585991112233` |
| `especialidades` | `TEXT` | Competências separadas por vírgula | `Inversor Solar, Cabos de Fibra, NR10` |
| `cidade_atendimento`| `VARCHAR(100)` | Cidade base de atuação técnica | `Fortaleza` |
| `estado_atendimento`| `VARCHAR(2)` | UF | `CE` |
| `status_prospec` | `ENUM` | Fase de onboarding | `Mapeado`, `Mensagem Enviada`, `Homologado` |
| `score_aderencia` | `DECIMAL(5,2)` | Percentual de aderência de competências | `85.50` |

---

## 3. Configuração de Webhooks e Gatilhos (Triggers)

O painel de CRM do NexoraField AI deve disparar webhooks automáticos para o n8n nos seguintes cenários:

### 3.1. Gatilho 1: Novo Lead Cadastrado/Mapeado (`lead.created`)
*   **Gatilho:** Executado quando um novo lead de empresa ou técnico é inserido no sistema (via scraping ou input manual).
*   **Ação no n8n:** Avaliar o perfil e iniciar a régua de nutrição inicial em até 10 minutos.

#### Payload JSON de Exemplo:
```json
{
  "event": "lead.created",
  "timestamp": "2026-06-25T17:52:00-03:00",
  "tenant_id": "nexora-default",
  "data": {
    "lead_type": "company",
    "id": "lead_comp_9281",
    "razao_social": "SolarSul Distribuidora Ltda",
    "responsavel_nome": "Julio Cesar Camargo",
    "telefone": "+5519998887766",
    "email": "comercial@solarsul.com.br",
    "cidade": "Campinas",
    "estado": "SP",
    "segmento": "Instalação Solar",
    "status_funil": "Fria",
    "lgpd_consent": true
  }
}
```

### 3.2. Gatilho 2: Mudança de Fase no Funil (`lead.stage_changed`)
*   **Gatilho:** Executado quando o comercial ou uma automação interna move o lead de estágio no quadro Kanban.
*   **Ação no n8n:** Pausar a régua fria e enviar o link de agendamento de demonstração (via Calendly integrado).

#### Payload JSON de Exemplo:
```json
{
  "event": "lead.stage_changed",
  "timestamp": "2026-06-25T17:53:10-03:00",
  "tenant_id": "nexora-default",
  "data": {
    "lead_type": "company",
    "id": "lead_comp_9281",
    "previous_stage": "Fria",
    "new_stage": "Contatado",
    "updated_by": "adm-01",
    "last_interaction": "Mensagem de primeiro contato enviada pelo bot n8n"
  }
}
```

---

## 4. Integração n8n (Desenho do Workflow)

O workflow completo no n8n deve conter as seguintes etapas de processamento lógico:

1.  **Nó Webhook Trigger:** Ouve as chamadas do NexoraField AI (`/api/v1/webhooks/crm`).
2.  **Nó Switch/Router:** Direciona o fluxo baseado no `lead_type` (`company` ou `tech`).
3.  **Nó Gemini AI Agent:** Analisa o perfil do lead (cidade, serviços, tamanho) e gera uma abordagem customizada, utilizando técnicas de copywriting direcionadas a donos de distribuidoras ou técnicos.
4.  **Nó Router de Canal:**
    *   Se possui telefone: Enviar via **WhatsApp API** (prioritário).
    *   Se possui e-mail e não respondeu ao Whats em 24h: Enviar e-mail de acompanhamento com proposta comercial anexada.
5.  **Nó HTTP Request (Mensageria):** Consome a API de envio correspondente (detalhada no tópico 5).
6.  **Nó HTTP Request (Retorno ao NexoraField):** Atualiza o status do lead para `Contatado` na API do CRM para evitar duplicidade de disparos.

---

## 5. Endpoints de Integração com APIs de Mensageria

Abaixo estão definidos os padrões de endpoints recomendados para conexão aos gateways reais.

### 5.1. WhatsApp (Integração via Evolution API / Z-API)
Recomendado pela robustez no envio de mensagens dinâmicas e links de convites.

*   **Endpoint:** `POST https://api.sua-evolution.com/message/sendText`
*   **Headers:**
    *   `Content-Type: application/json`
    *   `apikey: YOUR_SECRET_EVOLUTION_KEY`
*   **Body (JSON):**
```json
{
  "number": "5519998887766",
  "options": {
    "delay": 1200,
    "presence": "composing"
  },
  "textMessage": {
    "text": "Olá Julio Cesar! Sou o assistente de expansão da NexoraField AI. Notamos sua forte atuação em Campinas no setor de Instalação Solar e gostaríamos de apresentar nossa plataforma de despacho autônomo de ordens de serviço. Ela pode reduzir seus custos de deslocamento em até 30%. Gostaria de ver uma demonstração rápida de 5 minutos?\n\nResponda SIM para agendarmos."
  }
}
```

### 5.2. SMS Corporativo (Twilio SMS Gateway)
Canal secundário de altíssima taxa de entrega para urgências e convites rápidos a técnicos sem internet ativa.

*   **Endpoint:** `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`
*   **Auth:** Basic Auth (`Username = AccountSid`, `Password = AuthToken`)
*   **Body (Form Data):**
```ini
To=+5519998887766
From=+1234567890
Body=NexoraField AI: Olá Julio, seu cadastro de homologação técnica foi aprovado. Acesse a plataforma e pegue sua primeira OS de painel solar hoje! Link: nexorafield.com/app
```

### 5.3. E-mail de Prospecção (Resend / SendGrid)
Usado para envio formal de apresentações, contratos e notas fiscais de adesão ao SaaS.

*   **Endpoint:** `POST https://api.resend.com/emails`
*   **Headers:**
    *   `Content-Type: application/json`
    *   `Authorization: Bearer YOUR_RESEND_API_KEY`
*   **Body (JSON):**
```json
{
  "from": "comercial@nexorafield.com.br",
  "to": ["comercial@solarsul.com.br"],
  "subject": "Otimize suas Ordens de Serviço Solar com a NexoraField AI",
  "html": "<p>Olá <strong>Julio Cesar</strong>,</p><p>Sabemos que gerenciar técnicos externos de instalação fotovoltaica é um desafio. O NexoraField AI automatiza o matching geográfico, valida checklists de NR10/NR35 em tempo real e calcula splits de repasse de forma transparente.</p><p><a href='https://nexorafield.com/demo'>Clique aqui para agendar sua simulação ao vivo</a>.</p>"
}
```

---

## 6. Relatório de Maturidade Técnica & Progresso (Reality Map)

Como parte da nossa auditoria técnica baseada no painel de **Realidade do Sistema (Nexora Truth Guard)**, classificamos a maturidade atual dos módulos do sistema com as seguintes porcentagens de desenvolvimento operacional real:

*   **Abertura & Rastreamento de OS (Operações FSM):** `90% REAL`
    *   *Backend ativo, persistência em banco de dados de chamados, geofencing real integrado.*
*   **Planos, Assinaturas & Billing Administrativo:** `88% REAL`
    *   *Configurações de planos dinâmicos de comissão, cupons lógicos e logs de alteração totalmente salvos.*
*   **Motores de IA & Co-Pilotos de Auditoria:** `85% REAL`
    *   *Consumo direto do SDK oficial @google/genai, interpretando metadados reais sem stubs.*
*   **Autenticação & Multitenancy:** `65% PARCIAL`
    *   *Apresenta visual interativo para testes e alternância de papéis rápidos de UX no frontend, requerendo amarração definitiva dos middleware JWT no Express para produção.*
*   **Chat Corporativo 1:1 & Grupos:** `60% PARCIAL`
    *   *Componente interativo e responsivo montado na UI, necessitando de gateway Socket.io ou Firestore Realtime para sincronização inter-dispositivos.*
*   **CRM Comercial & Funil:** `55% PARCIAL`
    *   *Kanban robusto com ações lógicas e filtros, necessitando das conexões de Webhooks de saída para n8n detalhadas nesta documentação.*
*   **Split Payments & Repasse PIX:** `20% SIMULADO (MOCK)`
    *   *Gera a visualização perfeita de faturas e QR Codes, mas necessita de homologação e credenciais de parceiro bancário real para liquidação financeira.*
*   **Growth Engine (Prospecção Autônoma):** `15% SIMULADO`
    *   *Painel visual ativo e desenhado para demonstrações de leads coletados, necessitando da implantação da arquitetura de orquestração do n8n detalhada nos tópicos anteriores.*

---

*Documentação assinada digitalmente por **Nexora-Guard Compliance Services (v2.1)** em 25 de Junho de 2026.*
