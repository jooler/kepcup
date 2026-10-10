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
	/** 最近一次目录加载失败的错误文本（null = 正常）；弹框据此区分「空目录」与「加载失败」。 */
	loadError = $state<string | null>(null);
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
			this.loadError = null;
			this.#loaded = true;
		} catch (error) {
			// 调用方多是 `void load()`：不吞成未处理的 rejection，记录并透出。
			console.error('[skill-market] load failed', error);
			this.loadError =
				error instanceof Error && error.message.length > 0 ? error.message : String(error);
		} finally {
			this.loading = false;
		}
	}

	async install(presetId: string): Promise<void> {
		this.installing.add(presetId);
		try {
			await core.call('skills.presets.install', { presetId });
			// 成功：先刷新（load 自吞错误不抛出）再在 finally 摘除 installing——
			// 按钮从「添加中…」直接切「✓ 已添加」，不经停「添加」态。
			await this.load(true);
		} catch (error) {
			// 安装失败：也刷新对齐真实安装态再上抛（如「替换过期预置」在卸载
			// 旧行后才失败，不刷新会残留「可更新」的假状态）。
			await this.load(true);
			throw error;
		} finally {
			this.installing.delete(presetId);
		}
	}

	/** 弹框关闭后复位加载标记，避免下次打开闪现陈旧目录。 */
	reset(): void {
		this.presets = [];
		this.loadError = null;
		this.#loaded = false;
	}
}

export const skillMarket = new SkillMarketState();
