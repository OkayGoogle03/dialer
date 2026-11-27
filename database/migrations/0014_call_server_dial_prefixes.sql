-- 0014: the saved dial prefixes of each call server: [{"prefix": "91", "label": "Sales", "source": "manual" | "call_list"}]
ALTER TABLE call_servers ADD COLUMN dial_prefixes JSON NULL;
