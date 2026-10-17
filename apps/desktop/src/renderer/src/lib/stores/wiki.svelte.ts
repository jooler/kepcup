import type {
  WikiHistoryEntry,
  WikiOwner,
  WikiPage,
  WikiSearchHit,
  WikiSourceView,
} from '@kepcup/shared';
import { wikiOwnerKey } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * Wiki browsing state (P09 right panel; owner-partitioned in D92 T1b WP10 so
 * the bot panel and a project's Wiki tab can be open at the same time): one
 * page-tree slot per `wikiOwnerKey(owner)`, loaded on demand; `wiki_changed`
 * events refresh every loaded owner (ingest completions, dedupe skips, lint
 * commits and source removals all publish it, BR-P09-012).
 */
class WikiState {
	pages = $state<Record<string, WikiPage[]>>({});
	loading = $state<Record<string, boolean>>({});
	#loaded = new Set<string>();
	#started = false;

	start(): void {
		if (this.#started) return;
		this.#started = true;
		core.onEvent('wiki_changed', (payload) => {
			const data = payload as { owner?: { kind: 'bot' | 'project'; id: string } };
			if (data.owner === undefined) return;
			const key = wikiOwnerKey(data.owner);
			if (this.#loaded.has(key)) void this.load(data.owner, true);
		});
	}

	pagesOf(owner: WikiOwner): WikiPage[] {
		return this.pages[wikiOwnerKey(owner)] ?? [];
	}

	loadingOf(owner: WikiOwner): boolean {
		return this.loading[wikiOwnerKey(owner)] === true;
	}

	async load(owner: WikiOwner, force = false): Promise<void> {
		const key = wikiOwnerKey(owner);
		if (!force && this.#loaded.has(key)) return;
		this.loading[key] = true;
		try {
			const result = (await core.call('wiki.tree', { owner })) as { pages: WikiPage[] };
			this.pages[key] = result.pages;
			this.#loaded.add(key);
		} finally {
			this.loading[key] = false;
		}
	}

	async page(
		owner: WikiOwner,
		path: string,
	): Promise<{ path: string; title: string; content: string }> {
		return (await core.call('wiki.page', { owner, path })) as {
			path: string;
			title: string;
			content: string;
		};
	}

	async search(owner: WikiOwner, query: string): Promise<WikiSearchHit[]> {
		const result = (await core.call('wiki.search', { owner, query })) as {
			hits: WikiSearchHit[];
		};
		return result.hits;
	}

	async history(owner: WikiOwner): Promise<WikiHistoryEntry[]> {
		const result = (await core.call('wiki.history', { owner })) as {
			history: WikiHistoryEntry[];
		};
		return result.history;
	}

	/** Rollback creates a NEW commit (history grows); the tree reloads after. */
	async rollback(owner: WikiOwner, commitOid: string): Promise<void> {
		await core.call('wiki.rollback', { owner, commitOid });
		await this.load(owner, true);
	}

	/** Delete creates a NEW commit too (recoverable via rollback); reload after. */
	async deletePage(owner: WikiOwner, path: string): Promise<void> {
		await core.call('wiki.deletePage', { owner, path });
		await this.load(owner, true);
	}

	// --- project source ledger (D92 T1b WP10) -----------------------------------

	async sources(owner: WikiOwner): Promise<WikiSourceView[]> {
		const result = (await core.call('wiki.sources', { owner })) as { sources: WikiSourceView[] };
		return result.sources;
	}

	/** Enqueues the user-submitted ingest; the page appears on wiki_changed. */
	async addSource(
		owner: WikiOwner,
		input: { sourceType: 'url' | 'text'; ref: string; note?: string },
	): Promise<void> {
		await core.call('wiki.addSource', { owner, ...input });
	}

	/** Registers the async removal; the row disappears on wiki_changed. */
	async deleteSource(owner: WikiOwner, sourceId: string): Promise<void> {
		await core.call('wiki.deleteSource', { owner, sourceId });
	}
}

export const wikiStore = new WikiState();
