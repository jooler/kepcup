import type { WikiHistoryEntry, WikiPage, WikiSearchHit } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * P09 right-panel state: the viewed bot's wiki page tree. Loads on demand when
 * the tab opens; `wiki_changed` events refresh the loaded tree live (the same
 * pattern as `skills.changed` in P08 — ingest completions, dedupe skips and
 * lint commits all publish it, BR-P09-012).
 */
class WikiState {
	botId = $state<string | null>(null);
	pages = $state<WikiPage[]>([]);
	loading = $state(false);
	#loadedFor: string | null = null;
	#started = false;

	start(): void {
		if (this.#started) return;
		this.#started = true;
		core.onEvent('wiki_changed', (payload) => {
			const data = payload as { botId: string };
			if (data.botId === this.#loadedFor) void this.load(data.botId, true);
		});
	}

	async load(botId: string, force = false): Promise<void> {
		if (!force && this.#loadedFor === botId && this.botId === botId) return;
		this.loading = true;
		try {
			const result = (await core.call('wiki.tree', { botId })) as { pages: WikiPage[] };
			this.pages = result.pages;
			this.botId = botId;
			this.#loadedFor = botId;
		} finally {
			this.loading = false;
		}
	}

	async page(
		botId: string,
		path: string,
	): Promise<{ path: string; title: string; content: string }> {
		return (await core.call('wiki.page', { botId, path })) as {
			path: string;
			title: string;
			content: string;
		};
	}

	async search(botId: string, query: string): Promise<WikiSearchHit[]> {
		const result = (await core.call('wiki.search', { botId, query })) as {
			hits: WikiSearchHit[];
		};
		return result.hits;
	}

	async history(botId: string): Promise<WikiHistoryEntry[]> {
		const result = (await core.call('wiki.history', { botId })) as {
			history: WikiHistoryEntry[];
		};
		return result.history;
	}

	/** Rollback creates a NEW commit (history grows); the tree reloads after. */
	async rollback(botId: string, commitOid: string): Promise<void> {
		await core.call('wiki.rollback', { botId, commitOid });
		await this.load(botId, true);
	}

	/** Delete creates a NEW commit too (recoverable via rollback); reload after. */
	async deletePage(botId: string, path: string): Promise<void> {
		await core.call('wiki.deletePage', { botId, path });
		await this.load(botId, true);
	}
}

export const wikiStore = new WikiState();
