# Career Intelligence Assistant

a.	Quick setup instructions

b.	Architecture overview (a simple diagram is great but not required)

c.	What would be required to productionize your solution, make it scalable and deploy it on a hyper-scaler such as AWS / GCP / Azure / Cloudflare?

d.	RAG/LLM approach & decisions: Choices considered and final choice for LLM / embedding model / vector database / orchestration framework, prompt & context management, guardrails, quality, observability

## Choise considered:
- LLM : Claude haiku, chatgpt-4o, ollama models.
- embedding mode: openai/text-embedding-3-small, gemini emebeddings
- vector database: Postgres - pgvector, Supabase
- orchestation framework: 
- prompt & context management:
- guardrails: system prompt validation to avoid injections or querys out of context.  
- quality: Recall@K, Precision@K, hallucinations management, Reranking,  
- observability:

## Final choise:
- LLM: gemma
- embedding mode: gemini-embedding-001
- vector database: Postgres - pgvector
- orchestation framework: 
- prompt & context management:
- guardrails: structured output validation, structure input validations(avoid query injection). 
- quality: Recall@K, Precision@K, 0 hallucinations. Reranking 
- observability:

e.	Key technical decisions you made and why
Pdf is the common format to upload CVs and many other documents, is the standart. But, pdf is a layout and it cannot be managed as a simple plain text, therefore before start the chunking process i had to add an step zero, this was to add a llama-Extract, i define a structured schema to retreive the fields that i will need to manage the data from the pdf.

Then, for the chunking process i decide to use document structured-based chunking because a CV and JBs are divided by headers, sections, subsection and bullets, and this chunking method can divide it very well without cut the info in the middle. However, what happened if i ask for years of experience? how the LLM knows if i am talking about the JDs or my CV? so to solve that problem i decided to structure the metadata of the chunk as a tree(parents and childs), so the LLM will know where these chunks came from. Important to keep the context and improve the accuracy.

Another key technical desicion was about the management of the input query. Because the query might be ambiguos, broad or just need more than one document to get a good response, so...   

f.	Engineering standards you’ve followed (and maybe some that you skipped)

g.	How you used AI tools in your development process
First of all, i have to put the AI in context. Then i mentioned the tech stack that i am going to use and also i pasted my RAG architecture that i designed so it can understand better the idea of the solution. Then i discuss about if it see any gap in the workflow. So if he propose any stack or technology to use, i would first research it to understand this apporach and also the scalalbility. After that i like to divide my work into tasks or phases, each phase can contain from the step-0 to the final one. Each part of the development i use skills to review the code with Typechek and also to find for the laziest solution(ponytail) in terms of code. To get a clean approach without a lot of lines of code.  

I always update the context of the AI to avoid too large context windows and lose quality in the response. Each part of the code that it generate i reviewed to check if the logic works, if not i iterate until get a good apprach. Also i work with 2 windows, so in the first one i have the chat where i make the development and the other one is to have a clean context so any of them knows what each other does, this is useful to have responses non influenciated by others.

h.	What you'd do differently with more time
Improve the query: I will implement RAG Fusion to generate multiple similar queries based on the main query. Each generated query explores different formulations and perspectives of the user's intent. This would increase the probability of retrieving relevant chunks that might not be retrieved with the original query alone.

