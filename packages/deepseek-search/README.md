# DeepSeek Search

Lets Tomrade's assistant search the web and read pages through DeepSeek's search API, whatever model it runs on.

Nothing to set up. It uses the API key of your DeepSeek model in Settings → Models, and Tomrade puts it on by itself once you have one. Without a DeepSeek model, the assistant says that web search needs one with a key. A model that searches the web on its own (Claude through Anthropic's API) does not use it; with Tavily set up too, Tavily answers first.

What it does:

- `web_search` goes to `/v1/tools/search` ($0.75 per 1,000 searches at DeepSeek's prices; searches that find nothing are free). A search narrowed to one site uses DeepSeek's `site:` operator; one narrowed to several sites, a recent period or sites to leave out is filtered here from a full page of 50 results, which costs the same.
- `web_fetch` reads each page with `/v1/tools/fetch` ($0.75 per 1,000 pages), as Markdown; a page that cannot be read is listed with the reason.
- A refused key, an empty balance, a page DeepSeek will not read and the rate limit (5 searches and 5 page reads a second) are reported in words the assistant can pass on.

The plugin's network permission is `api.deepseek.com`; it reads the model settings only for the DeepSeek key.
