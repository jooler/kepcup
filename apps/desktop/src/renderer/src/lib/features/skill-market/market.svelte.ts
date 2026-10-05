import type { SkillPresetInfo } from '@kepcup/shared';
import { SvelteSet } from 'svelte/reactivity';
import { core } from '$lib/rpc/client.svelte';

/**
 * 技能市场状态：随应用分发的预置目录 + 全局安装态。目录与安装都是公共作用
 * 域（public_skills，所有 Bot 可用），因此没有目标 Bot 概念；弹框打开时加载
 * 一次，`skills.changed`（botId 为空串 = 公共技能变更）驱动刷新，让市场按钮
 * 与各 Bot 的技能面板保持一致。
 */
class SkillMarketState {
	presets = $state<SkillPresetInfo[]>([]);
	loading = $state(false);
	/** 正在安装的 presetId 集合（按钮 spinner）。 */
	installing = new SvelteSet<string>();
	#loaded = false;
	#started = false;

	start(): void {
		if (this.#started) return;
		this.#started = true;
		core.onEvent('skills.changed', (payload) => {
			const data = payload as { botId: string };
			if (data.botId === '' && this.#loaded) void this.load(true);
		});
	}

	async load(force = false): Promise<void> {
		if (!force && this.#loaded) return;
		this.loading = true;
		try {
			const result = (await core.call('skills.presets.list', undefined)) as {
				presets: SkillPresetInfo[];
			};
			this.presets = result.presets;
			this.#loaded = true;
		} finally {
			this.loading = false;
		}
	}

	async install(presetId: string): Promise<void> {
		this.installing.add(presetId);
		try {
			// skills.changed（botId=''）会触发刷新；这里只等安装落定。
			await core.call('skills.presets.install', { presetId });
		} finally {
			this.installing.delete(presetId);
		}
	}

	/** 弹框关闭后复位加载标记，避免下次打开闪现陈旧目录。 */
	reset(): void {
		this.presets = [];
		this.#loaded = false;
	}
}

export const skillMarket = new SkillMarketState();
