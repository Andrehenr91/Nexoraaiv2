# CLOUD_MIGRATION_PLAN.md — NexoraField AI v7.0
**Plano executivo de migração para Cloud Native Enterprise**

---

## RESUMO EXECUTIVO

Migração de plataforma monolítica single-instance para arquitetura Cloud Native Kubernetes na Google Cloud Platform (região southamerica-east1 / São Paulo), garantindo alta disponibilidade 99.9% SLA, escalabilidade para 100.000+ usuários e recuperação automática de falhas.

**Duração estimada:** 8 semanas | **Risco:** Médio (zero downtime garantido)

---

## FASES DA MIGRAÇÃO

### SEMANA 1-2: Fundação Cloud

| Tarefa | Responsável | Status |
|---|---|---|
| Criar projeto GCP (nexorafield-prod) | Cloud Architect | ✅ Planejado |
| Configurar VPC privada + sub-redes | Network Engineer | ✅ Planejado |
| Criar GKE Autopilot cluster | K8s Admin | ✅ Planejado |
| Configurar Artifact Registry | DevSecOps | ✅ Planejado |
| Migrar secrets para Secret Manager | Security Eng | ✅ Planejado |
| Setup Cloud Build pipeline | Platform Eng | ✅ Planejado |

### SEMANA 3: Banco de Dados

| Tarefa | Responsável | Status |
|---|---|---|
| Provisionar Cloud SQL PostgreSQL 15 HA | DB Architect | ✅ Planejado |
| Configurar PgBouncer connection pool | DB Architect | ✅ Planejado |
| Criar schemas e migrations (Drizzle ORM) | Backend Dev | ✅ Planejado |
| Configurar backup diário + PITR | DB Architect | ✅ Planejado |
| Setup read replica | DB Architect | ✅ Planejado |

### SEMANA 4: Cache e Filas

| Tarefa | Responsável | Status |
|---|---|---|
| Provisionar Memorystore Redis Sentinel | Platform Eng | ✅ Planejado |
| Implementar BullMQ (AI jobs assíncronos) | Backend Dev | ✅ Planejado |
| Configurar Dead Letter Queue | Backend Dev | ✅ Planejado |
| Setup Cloud Scheduler | Platform Eng | ✅ Planejado |

### SEMANA 5: Containerização

| Tarefa | Responsável | Status |
|---|---|---|
| Build Dockerfile multi-stage (API) | DevSecOps | ✅ **CONCLUÍDO** |
| Build Dockerfile (Worker AI) | DevSecOps | ✅ **CONCLUÍDO** |
| docker-compose para dev local | DevSecOps | ✅ **CONCLUÍDO** |
| Push imagens para Artifact Registry | DevSecOps | ✅ Planejado |
| Scan de vulnerabilidades (Trivy) | DevSecOps | ✅ Planejado |

### SEMANA 6: Kubernetes

| Tarefa | Responsável | Status |
|---|---|---|
| Criar namespaces + RBAC | K8s Admin | ✅ **CONCLUÍDO** |
| Deployments + Services + Ingress | K8s Admin | ✅ **CONCLUÍDO** |
| HPA (2–20 réplicas) | K8s Admin | ✅ **CONCLUÍDO** |
| PodDisruptionBudget | K8s Admin | ✅ **CONCLUÍDO** |
| NetworkPolicy | K8s Admin | ✅ **CONCLUÍDO** |
| ConfigMaps + Secrets | K8s Admin | ✅ **CONCLUÍDO** |

### SEMANA 7: Segurança e Observabilidade

| Tarefa | Responsável | Status |
|---|---|---|
| Cloud Armor WAF (OWASP Top 10) | Security Eng | ✅ Planejado |
| Cloud CDN + SSL/TLS 1.3 | Network Eng | ✅ Planejado |
| OpenTelemetry tracing | SRE | ✅ Planejado |
| Prometheus + Grafana dashboards | SRE | ✅ Planejado |
| Alertas PagerDuty | SRE | ✅ Planejado |
| Health endpoints (/api/health, /api/metrics) | Backend Dev | ✅ **CONCLUÍDO** |

### SEMANA 8: CI/CD e Go-Live

| Tarefa | Responsável | Status |
|---|---|---|
| GitHub Actions pipeline completo | DevSecOps | ✅ **CONCLUÍDO** |
| Canary deployment (20% → 100%) | DevSecOps | ✅ Planejado |
| Load testing (k6: 10k usuários) | SRE | ✅ Planejado |
| Disaster recovery drill | SRE | ✅ Planejado |
| Documentação final | Platform Eng | ✅ **CONCLUÍDO** |
| Go-Live produção | Todos | ⏳ Pendente |

---

## ESTRATÉGIA DE ROLLBACK

```
Deploy Falhou?
     │
     ├─ Automático (CI/CD detecta health check falho)
     │   └─ kubectl rollout undo deployment/nexora-api
     │       └─ Versão anterior restaurada em <3 min
     │
     └─ Manual (incidente crítico)
         └─ kubectl set image deployment/nexora-api api=<previous-sha>
```

---

## CRITÉRIOS DE GO-LIVE

- [ ] Health check /api/health respondendo 200
- [ ] Todos os pods Running (kubectl get pods)
- [ ] Banco com backup configurado e testado
- [ ] Redis operacional com Sentinel
- [ ] CI/CD pipeline executado com sucesso
- [ ] Load test 1000 usuários sem degradação
- [ ] Alertas configurados e testados
- [ ] DR drill executado (RTO < 15 min)
- [ ] GEMINI_API_KEY configurada no Secret Manager
- [ ] Documentação atualizada

---

## RISCOS E MITIGAÇÕES

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Latência Gemini API | Alta | Médio | Cache Redis + fallback síncrono |
| Custo IA acima do previsto | Média | Alto | Budget alerts + rate limiting |
| Migração de dados mock → PostgreSQL | Alta | Alto | Migration scripts + validação |
| Certificado TLS expirado | Baixa | Alto | Let's Encrypt auto-renovação |
| GEMINI_API_KEY comprometida | Baixa | Crítico | Rotação automática Secret Manager |
