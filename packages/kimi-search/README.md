# Kimi Search

Lets Tomrade's assistant search the web and read pages through Kimi's search API (Moonshot), whatever model it runs on.

Nothing to set up. It uses the API key of your Kimi model in Settings → Models, on that model's host (`api.moonshot.cn` or `api.moonshot.ai`); a `MOONSHOT_API_KEY` in your shell is offered there as a Kimi model when you add one. Without a Kimi model, the assistant says that web search needs one with a key. A model that searches the web on its own (Claude through Anthropic's API) does not use it; with Tavily set up too, Tavily answers first.

What it does:

- `web_search` goes to `/v1/tools/search` ($0.002 a call at Moonshot's prices). Only a search narrowed to sites (up to 5) or to a recent period uses `/v1/tools/search_pro` ($0.003); sites to leave out are dropped from the results here. Calls that find nothing are free.
- `web_fetch` reads each page with `/v1/tools/fetch` ($0.002 a page), as Markdown; a page that cannot be read is listed with the reason.
- A refused key, a suspended account and a rate limit are reported in words the assistant can pass on.

The plugin's network permission is the two Moonshot hosts; it reads the model settings only for the Kimi key.
