<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { parsedEnvStore, requiredEnvStore } from '$lib/state/derived';
	import { envStore } from '$lib/state/env';
	import { createEventDispatcher } from 'svelte';
	import EnvEditor from './env-editor.svelte';
	import Button from './ui/button/button.svelte';

	export let open = false;
	export let canClose = true;

	const dispatch = createEventDispatcher();

	let envEditorEntries: [string, string][];
	$: {
		open; // Reset when settings visible closes without a change
		envEditorEntries = $requiredEnvStore.map((req) => [req, $parsedEnvStore[req]]);
	}

	function saveEnv() {
		const newEnv = { ...$parsedEnvStore };
		for (const [key, value] of envEditorEntries) {
			newEnv[key] = value;
		}
		envStore.set(
			Object.entries(newEnv)
				.map(([key, value]) => `${key}=${value}`)
				.join('\n')
		);
		dispatchOpenState(false);
	}

	function dispatchOpenState(open: boolean) {
		dispatch('open-change', open);
	}
</script>

<Dialog.Root
	{open}
	closeOnEscape={canClose}
	closeOnOutsideClick={canClose}
	onOpenChange={dispatchOpenState}
>
	<Dialog.Content hideCloseButton={!canClose}>
		<Dialog.Header>
			<Dialog.Title>Settings</Dialog.Title>
			<Dialog.Description>Configure your environment</Dialog.Description>
		</Dialog.Header>
		<div>
			<EnvEditor entries={envEditorEntries}></EnvEditor>
		</div>
		<Dialog.Footer>
			<Button type="submit" on:click={saveEnv}>Save changes</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
