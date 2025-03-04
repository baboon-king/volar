import { enableAllFeatures } from '../generators/utils';
import { VueLanguagePlugin } from '../types';

const customBlockReg = /^(.*)\.customBlock_([^_]+)_(\d+)\.([^.]+)$/;

const plugin: VueLanguagePlugin = () => {

	return {

		version: 1,

		getEmbeddedFileNames(fileName, sfc) {
			const names: string[] = [];
			for (let i = 0; i < sfc.customBlocks.length; i++) {
				const customBlock = sfc.customBlocks[i];
				names.push(fileName + '.customBlock_' + customBlock.type + '_' + i + '.' + customBlock.lang);
			}
			return names;
		},

		resolveEmbeddedFile(_fileName, sfc, embeddedFile) {
			const match = embeddedFile.fileName.match(customBlockReg);
			if (match) {
				const index = parseInt(match[3]);
				const customBlock = sfc.customBlocks[index];

				embeddedFile.content.push([
					customBlock.content,
					customBlock.name,
					0,
					enableAllFeatures({}),
				]);
			}
		},
	};
};

export default plugin;
