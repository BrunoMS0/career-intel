# Career Intelligence Assistant

a.	Quick setup instructions

b.	Architecture overview (a simple diagram is great but not required)

c.	What would be required to productionize your solution, make it scalable and deploy it on a hyper-scaler such as AWS / GCP / Azure / Cloudflare?

d.	RAG/LLM approach & decisions: Choices considered and final choice for LLM / embedding model / vector database / orchestration framework, prompt & context management, guardrails, quality, observability

## Choise considered:
- # LLM : Claude haiku 
- # embedding mode: openai/text-embedding-3-small
- # vector database: Postgres - pgvector
- # orchestation framework: 
- # prompt & context management:
- # guardrails: structured output validation, structure input validations(avoid query injection). 
- # quality: Recall@K, Precision@K, 0 hallucinations. Reranking 
- # observability:

## Final choise:
- # LLM: gemini-3.7-flash
- # embedding mode: gemini-embedding-001
- # vector database: Postgres - pgvector
- # orchestation framework: 
- # prompt & context management:
- # guardrails: structured output validation, structure input validations(avoid query injection). 
- # quality: Recall@K, Precision@K, 0 hallucinations. Reranking 
- # observability:

e.	Key technical decisions you made and why
Pdf is the common format to upload CVs and many other documents, is the standart. But, pdf is a layout and it cannot be managed as a simple plain text, therefore before start the chunking process i had to add an step zero, this was to add a llama-parse to get an structure text. Also this library is compatible with TypeScript.

Then, for the chunking process i decide to use document structured-based chunking because a CV and JBs are divided by headers, sections, subsection and bullets, and this chunking method can divide it very well without cut the info in the middle. However, what happened if i ask for years of experience? how the LLM knows if i am talking about the JDs or my CV? so to solve that problem i decided to structure the metadata of the chunk as a tree(parents and childs), so the LLM will know where these chunks came from. Important to keep the context and improve the accuracy.  

f.	Engineering standards you’ve followed (and maybe some that you skipped)

g.	How you used AI tools in your development process
First of all, i have to put the AI in context. Then i mentioned the tech stack that i am going to use and also i pasted my RAG architecture that i designed so it can understand better the idea of the solution. Then i discuss about if it see any gap in the workflow. So if he propose any stack or technology to use, i would first research it to understand this apporach and also the scalalbility. After that i like to divide my work into tasks or phases, each phase can contain from the step-0 to the final one. We start with the setup, then   

h.	What you'd do differently with more time

