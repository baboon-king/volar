import { CodeInformation, ServiceEnvironment, ServicePluginInstance, SourceMapWithDocuments } from '@volar/language-service';
import { VueFile, hyphenateAttr, hyphenateTag, parseScriptSetupRanges, tsCodegen } from '@vue/language-core';
import { camelize, capitalize } from '@vue/shared';
import { Provide } from 'volar-service-typescript';
import * as html from 'vscode-html-languageservice';
import type * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getComponentNames, getElementAttrs, getEventsOfTag, getPropsByTag, getTemplateCtx } from '../helpers';
import { getNameCasing } from '../ideFeatures/nameCasing';
import { AttrNameCasing, ServicePlugin, TagNameCasing, VueCompilerOptions } from '../types';
import { loadModelModifiersData, loadTemplateData } from './data';

let builtInData: html.HTMLDataV1;
let modelData: html.HTMLDataV1;

export function create(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	baseServide: ServicePlugin,
	getVueOptions: (env: ServiceEnvironment) => VueCompilerOptions,
	options: {
		getScanner(service: ServicePluginInstance, document: TextDocument): html.Scanner | undefined,
		updateCustomData(service: ServicePluginInstance, extraData: html.IHTMLDataProvider[]): void,
		isSupportedDocument: (document: TextDocument) => boolean,
	}
): ServicePlugin {
	return {
		name: 'vue-template',
		triggerCharacters: [
			...baseServide.triggerCharacters ?? [],
			'@', // vue event shorthand
		],
		create(context): ServicePluginInstance {

			const baseServiceInstance = baseServide.create(context);
			const vueCompilerOptions = getVueOptions(context.env);

			builtInData ??= loadTemplateData(context.env.locale ?? 'en');
			modelData ??= loadModelModifiersData(context.env.locale ?? 'en');

			// https://vuejs.org/api/built-in-directives.html#v-on
			// https://vuejs.org/api/built-in-directives.html#v-bind
			const eventModifiers: Record<string, string> = {};
			const propModifiers: Record<string, string> = {};
			const vOn = builtInData.globalAttributes?.find(x => x.name === 'v-on');
			const vBind = builtInData.globalAttributes?.find(x => x.name === 'v-bind');

			if (vOn) {
				const markdown = (typeof vOn.description === 'string' ? vOn.description : vOn.description?.value) ?? '';
				const modifiers = markdown
					.split('\n- ')[4]
					.split('\n').slice(2, -1);
				for (let text of modifiers) {
					text = text.substring('  - `.'.length);
					const [name, disc] = text.split('` - ');
					eventModifiers[name] = disc;
				}
			}
			if (vBind) {
				const markdown = (typeof vBind.description === 'string' ? vBind.description : vBind.description?.value) ?? '';
				const modifiers = markdown
					.split('\n- ')[4]
					.split('\n').slice(2, -1);
				for (let text of modifiers) {
					text = text.substring('  - `.'.length);
					const [name, disc] = text.split('` - ');
					propModifiers[name] = disc;
				}
			}

			return {

				...baseServiceInstance,

				async provideCompletionItems(document, position, completionContext, token) {

					if (!options.isSupportedDocument(document))
						return;

					const [virtualFile] = context.language.files.getVirtualFile(context.env.uriToFileName(document.uri));

					if (virtualFile) {
						for (const map of context.documents.getMaps(virtualFile)) {
							const sourceVirtualFile = context.language.files.getSourceFile(context.env.uriToFileName(map.sourceFileDocument.uri))?.virtualFile?.[0];
							if (sourceVirtualFile instanceof VueFile) {
								await provideHtmlData(map, sourceVirtualFile);
							}
						}
					}

					const htmlComplete = await baseServiceInstance.provideCompletionItems?.(document, position, completionContext, token);
					if (!htmlComplete)
						return;

					if (virtualFile) {
						for (const map of context.documents.getMaps(virtualFile)) {
							const sourceVirtualFile = context.language.files.getSourceFile(context.env.uriToFileName(map.sourceFileDocument.uri))?.virtualFile?.[0];
							if (sourceVirtualFile instanceof VueFile) {
								afterHtmlCompletion(htmlComplete, map, sourceVirtualFile);
							}
						}
					}

					return htmlComplete;
				},

				async provideInlayHints(document) {

					if (!options.isSupportedDocument(document))
						return;

					const enabled = await context.env.getConfiguration?.<boolean>('vue.inlayHints.missingProps') ?? false;
					if (!enabled)
						return;

					const languageService = context.inject<Provide, 'typescript/languageService'>('typescript/languageService');
					const result: vscode.InlayHint[] = [];
					const [virtualFile] = context.language.files.getVirtualFile(context.env.uriToFileName(document.uri));
					if (!virtualFile)
						return;

					for (const map of context.documents.getMaps(virtualFile)) {

						const sourceVirtualFile = context.language.files.getSourceFile(context.env.uriToFileName(map.sourceFileDocument.uri))?.virtualFile?.[0];
						const scanner = options.getScanner(baseServiceInstance, document);

						if (sourceVirtualFile instanceof VueFile && scanner) {

							// visualize missing required props
							const casing = await getNameCasing(ts, context, map.sourceFileDocument.uri, vueCompilerOptions);
							const components = getComponentNames(ts, languageService, sourceVirtualFile, vueCompilerOptions);
							const componentProps: Record<string, string[]> = {};
							let token: html.TokenType;
							let current: {
								unburnedRequiredProps: string[];
								labelOffset: number;
								insertOffset: number;
							} | undefined;
							while ((token = scanner.scan()) !== html.TokenType.EOS) {
								if (token === html.TokenType.StartTag) {
									const tagName = scanner.getTokenText();
									const component =
										tagName.indexOf('.') >= 0
											? components.find(component => component === tagName.split('.')[0])
											: components.find(component => component === tagName || hyphenateTag(component) === tagName);
									const checkTag = tagName.indexOf('.') >= 0 ? tagName : component;
									if (checkTag) {
										componentProps[checkTag] ??= getPropsByTag(ts, languageService, sourceVirtualFile, checkTag, vueCompilerOptions, true);
										current = {
											unburnedRequiredProps: [...componentProps[checkTag]],
											labelOffset: scanner.getTokenOffset() + scanner.getTokenLength(),
											insertOffset: scanner.getTokenOffset() + scanner.getTokenLength(),
										};
									}
								}
								else if (token === html.TokenType.AttributeName) {
									if (current) {
										let attrText = scanner.getTokenText();

										if (attrText === 'v-bind') {
											current.unburnedRequiredProps = [];
										}
										else {
											// remove modifiers
											if (attrText.indexOf('.') >= 0) {
												attrText = attrText.split('.')[0];
											}
											// normalize
											if (attrText.startsWith('v-bind:')) {
												attrText = attrText.substring('v-bind:'.length);
											}
											else if (attrText.startsWith(':')) {
												attrText = attrText.substring(':'.length);
											}
											else if (attrText.startsWith('v-model:')) {
												attrText = attrText.substring('v-model:'.length);
											}
											else if (attrText === 'v-model') {
												attrText = vueCompilerOptions.target >= 3 ? 'modelValue' : 'value'; // TODO: support for experimentalModelPropName?
											}
											else if (attrText.startsWith('@')) {
												attrText = 'on-' + hyphenateAttr(attrText.substring('@'.length));
											}

											current.unburnedRequiredProps = current.unburnedRequiredProps.filter(propName => {
												return attrText !== propName
													&& attrText !== hyphenateAttr(propName);
											});
										}
									}
								}
								else if (token === html.TokenType.StartTagSelfClose || token === html.TokenType.StartTagClose) {
									if (current) {
										for (const requiredProp of current.unburnedRequiredProps) {
											result.push({
												label: `${requiredProp}!`,
												paddingLeft: true,
												position: document.positionAt(current.labelOffset),
												kind: 2 satisfies typeof vscode.InlayHintKind.Parameter,
												textEdits: [{
													range: {
														start: document.positionAt(current.insertOffset),
														end: document.positionAt(current.insertOffset),
													},
													newText: ` :${casing.attr === AttrNameCasing.Kebab ? hyphenateAttr(requiredProp) : requiredProp}=`,
												}],
											});
										}
										current = undefined;
									}
								}
								if (token === html.TokenType.AttributeName || token === html.TokenType.AttributeValue) {
									if (current) {
										current.insertOffset = scanner.getTokenOffset() + scanner.getTokenLength();
									}
								}
							}
						}
					}

					return result;
				},

				provideHover(document, position, token) {

					if (!options.isSupportedDocument(document))
						return;

					if (context.language.files.getVirtualFile(context.env.uriToFileName(document.uri))[0])
						options.updateCustomData(baseServiceInstance, []);

					return baseServiceInstance.provideHover?.(document, position, token);
				},

				async provideDiagnostics(document, token) {

					if (!options.isSupportedDocument(document))
						return;

					const originalResult = await baseServiceInstance.provideDiagnostics?.(document, token);
					const [virtualFile] = context.language.files.getVirtualFile(context.env.uriToFileName(document.uri));

					if (!virtualFile)
						return;

					for (const map of context.documents.getMaps(virtualFile)) {

						const sourceVirtualFile = context.language.files.getSourceFile(context.env.uriToFileName(map.sourceFileDocument.uri))?.virtualFile?.[0];
						if (!(sourceVirtualFile instanceof VueFile))
							continue;

						const templateErrors: vscode.Diagnostic[] = [];
						const { template } = sourceVirtualFile.sfc;

						if (template) {

							for (const error of template.errors) {
								onCompilerError(error, 1 satisfies typeof vscode.DiagnosticSeverity.Error);
							}

							for (const warning of template.warnings) {
								onCompilerError(warning, 2 satisfies typeof vscode.DiagnosticSeverity.Warning);
							}

							function onCompilerError(error: NonNullable<typeof template>['errors'][number], severity: vscode.DiagnosticSeverity) {

								const templateHtmlRange = {
									start: error.loc?.start.offset ?? 0,
									end: error.loc?.end.offset ?? 0,
								};
								let errorMessage = error.message;

								templateErrors.push({
									range: {
										start: document.positionAt(templateHtmlRange.start),
										end: document.positionAt(templateHtmlRange.end),
									},
									severity,
									code: error.code,
									source: 'vue',
									message: errorMessage,
								});
							}
						}

						return [
							...originalResult ?? [],
							...templateErrors,
						];
					}
				},

				async provideDocumentSemanticTokens(document, range, legend, token) {

					if (!options.isSupportedDocument(document))
						return;

					const result = await baseServiceInstance.provideDocumentSemanticTokens?.(document, range, legend, token) ?? [];
					const scanner = options.getScanner(baseServiceInstance, document);
					if (!scanner)
						return;

					const languageService = context.inject<Provide, 'typescript/languageService'>('typescript/languageService');
					const [virtualFile] = context.language.files.getVirtualFile(context.env.uriToFileName(document.uri));
					if (!virtualFile)
						return;

					for (const map of context.documents.getMaps(virtualFile)) {

						const sourceFile = context.language.files.getSourceFile(context.env.uriToFileName(map.sourceFileDocument.uri))?.virtualFile?.[0];
						if (!(sourceFile instanceof VueFile))
							continue;

						const templateScriptData = getComponentNames(ts, languageService, sourceFile, vueCompilerOptions);
						const components = new Set([
							...templateScriptData,
							...templateScriptData.map(hyphenateTag),
						]);
						const offsetRange = {
							start: document.offsetAt(range.start),
							end: document.offsetAt(range.end),
						};

						let token = scanner.scan();

						while (token !== html.TokenType.EOS) {

							const tokenOffset = scanner.getTokenOffset();

							// TODO: fix source map perf and break in while condition
							if (tokenOffset > offsetRange.end)
								break;

							if (tokenOffset >= offsetRange.start && (token === html.TokenType.StartTag || token === html.TokenType.EndTag)) {

								const tokenText = scanner.getTokenText();

								if (components.has(tokenText) || tokenText.indexOf('.') >= 0) {

									const tokenLength = scanner.getTokenLength();
									const tokenPosition = document.positionAt(tokenOffset);

									if (components.has(tokenText)) {
										let tokenType = legend.tokenTypes.indexOf('component');
										if (tokenType === -1) {
											tokenType = legend.tokenTypes.indexOf('class');
										}
										result.push([tokenPosition.line, tokenPosition.character, tokenLength, tokenType, 0]);
									}
								}
							}
							token = scanner.scan();
						}
					}

					return result;
				},
			};

			async function provideHtmlData(map: SourceMapWithDocuments<CodeInformation>, vueSourceFile: VueFile) {

				const languageService = context.inject<Provide, 'typescript/languageService'>('typescript/languageService');
				const casing = await getNameCasing(ts, context, map.sourceFileDocument.uri, vueCompilerOptions);

				if (builtInData.tags) {
					for (const tag of builtInData.tags) {
						if (tag.name === 'slot')
							continue;
						if (tag.name === 'component')
							continue;
						if (tag.name === 'template')
							continue;
						if (casing.tag === TagNameCasing.Kebab) {
							tag.name = hyphenateTag(tag.name);
						}
						else {
							tag.name = camelize(capitalize(tag.name));
						}
					}
				}

				options.updateCustomData(baseServiceInstance, [
					html.newHTMLDataProvider('vue-template-built-in', builtInData),
					{
						getId: () => 'vue-template',
						isApplicable: () => true,
						provideTags: () => {

							const components = getComponentNames(ts, languageService, vueSourceFile, vueCompilerOptions)
								.filter(name =>
									name !== 'Transition'
									&& name !== 'TransitionGroup'
									&& name !== 'KeepAlive'
									&& name !== 'Suspense'
									&& name !== 'Teleport'
								);
							const scriptSetupRanges = vueSourceFile.sfc.scriptSetup ? parseScriptSetupRanges(ts, vueSourceFile.sfc.scriptSetup.ast, vueCompilerOptions) : undefined;
							const names = new Set<string>();
							const tags: html.ITagData[] = [];

							for (const tag of components) {
								if (casing.tag === TagNameCasing.Kebab) {
									names.add(hyphenateTag(tag));
								}
								else if (casing.tag === TagNameCasing.Pascal) {
									names.add(tag);
								}
							}

							for (const binding of scriptSetupRanges?.bindings ?? []) {
								const name = vueSourceFile.sfc.scriptSetup!.content.substring(binding.start, binding.end);
								if (casing.tag === TagNameCasing.Kebab) {
									names.add(hyphenateTag(name));
								}
								else if (casing.tag === TagNameCasing.Pascal) {
									names.add(name);
								}
							}

							for (const name of names) {
								tags.push({
									name: name,
									attributes: [],
								});
							}

							return tags;
						},
						provideAttributes: (tag) => {

							if (!vueSourceFile.mainTsFile)
								return [];

							const attrs = getElementAttrs(ts, languageService, vueSourceFile.mainTsFile.fileName, tag);
							const props = new Set(getPropsByTag(ts, languageService, vueSourceFile, tag, vueCompilerOptions));
							const events = getEventsOfTag(ts, languageService, vueSourceFile, tag, vueCompilerOptions);
							const attributes: html.IAttributeData[] = [];
							const _tsCodegen = tsCodegen.get(vueSourceFile.sfc);

							if (_tsCodegen) {
								let ctxVars = [
									..._tsCodegen.scriptRanges()?.bindings.map(binding => vueSourceFile.sfc.script!.content.substring(binding.start, binding.end)) ?? [],
									..._tsCodegen.scriptSetupRanges()?.bindings.map(binding => vueSourceFile.sfc.scriptSetup!.content.substring(binding.start, binding.end)) ?? [],
									...getTemplateCtx(ts, languageService, vueSourceFile) ?? [],
								];
								ctxVars = [...new Set(ctxVars)];
								const dirs = ctxVars.map(hyphenateAttr).filter(v => v.startsWith('v-'));
								for (const dir of dirs) {
									attributes.push(
										{
											name: dir,
										},
									);
								}
							}

							for (const prop of [...props, ...attrs]) {

								const isGlobal = !props.has(prop);
								const name = casing.attr === AttrNameCasing.Camel ? prop : hyphenateAttr(prop);

								if (hyphenateAttr(name).startsWith('on-')) {

									const propNameBase = name.startsWith('on-')
										? name.slice('on-'.length)
										: (name['on'.length].toLowerCase() + name.slice('onX'.length));
									const propKey = createInternalItemId('componentEvent', [isGlobal ? '*' : tag, propNameBase]);

									attributes.push(
										{
											name: 'v-on:' + propNameBase,
											description: propKey,
										},
										{
											name: '@' + propNameBase,
											description: propKey,
										},
									);
								}
								{

									const propName = name;
									const propKey = createInternalItemId('componentProp', [isGlobal ? '*' : tag, propName]);

									attributes.push(
										{
											name: propName,
											description: propKey,
										},
										{
											name: ':' + propName,
											description: propKey,
										},
										{
											name: 'v-bind:' + propName,
											description: propKey,
										},
									);
								}
							}

							for (const event of events) {

								const name = casing.attr === AttrNameCasing.Camel ? event : hyphenateAttr(event);
								const propKey = createInternalItemId('componentEvent', [tag, name]);

								attributes.push({
									name: 'v-on:' + name,
									description: propKey,
								});
								attributes.push({
									name: '@' + name,
									description: propKey,
								});
							}

							const models: [boolean, string][] = [];

							for (const prop of [...props, ...attrs]) {
								if (prop.startsWith('onUpdate:')) {
									const isGlobal = !props.has(prop);
									models.push([isGlobal, prop.substring('onUpdate:'.length)]);
								}
							}
							for (const event of events) {
								if (event.startsWith('update:')) {
									models.push([false, event.substring('update:'.length)]);
								}
							}

							for (const [isGlobal, model] of models) {

								const name = casing.attr === AttrNameCasing.Camel ? model : hyphenateAttr(model);
								const propKey = createInternalItemId('componentProp', [isGlobal ? '*' : tag, name]);

								attributes.push({
									name: 'v-model:' + name,
									description: propKey,
								});

								if (model === 'modelValue') {
									attributes.push({
										name: 'v-model',
										description: propKey,
									});
								}
							}

							return attributes;
						},
						provideValues: () => [],
					},
				]);
			}

			function afterHtmlCompletion(completionList: vscode.CompletionList, map: SourceMapWithDocuments<CodeInformation>, vueSourceFile: VueFile) {

				const languageService = context.inject<Provide, 'typescript/languageService'>('typescript/languageService');
				const replacement = getReplacement(completionList, map.sourceFileDocument);
				const componentNames = new Set(getComponentNames(ts, languageService, vueSourceFile, vueCompilerOptions).map(hyphenateTag));

				if (replacement) {

					const isEvent = replacement.text.startsWith('v-on:') || replacement.text.startsWith('@');
					const isProp = replacement.text.startsWith('v-bind:') || replacement.text.startsWith(':');
					const isModel = replacement.text.startsWith('v-model:') || replacement.text.split('.')[0] === 'v-model';
					const hasModifier = replacement.text.includes('.');
					const validModifiers =
						isEvent ? eventModifiers
							: isProp ? propModifiers
								: undefined;
					const modifiers = replacement.text.split('.').slice(1);
					const textWithoutModifier = replacement.text.split('.')[0];

					if (validModifiers && hasModifier) {

						for (const modifier in validModifiers) {

							if (modifiers.includes(modifier))
								continue;

							const modifierDes = validModifiers[modifier];
							const insertText = textWithoutModifier + modifiers.slice(0, -1).map(m => '.' + m).join('') + '.' + modifier;
							const newItem: html.CompletionItem = {
								label: modifier,
								filterText: insertText,
								documentation: {
									kind: 'markdown',
									value: modifierDes,
								},
								textEdit: {
									range: replacement.textEdit.range,
									newText: insertText,
								},
								kind: 20 satisfies typeof vscode.CompletionItemKind.EnumMember,
							};

							completionList.items.push(newItem);
						}
					}
					else if (hasModifier && isModel) {

						for (const modifier of modelData.globalAttributes ?? []) {

							if (modifiers.includes(modifier.name))
								continue;

							const insertText = textWithoutModifier + modifiers.slice(0, -1).map(m => '.' + m).join('') + '.' + modifier.name;
							const newItem: html.CompletionItem = {
								label: modifier.name,
								filterText: insertText,
								documentation: {
									kind: 'markdown',
									value: (typeof modifier.description === 'object' ? modifier.description.value : modifier.description)
										+ '\n\n' + modifier.references?.map(ref => `[${ref.name}](${ref.url})`).join(' | '),
								},
								textEdit: {
									range: replacement.textEdit.range,
									newText: insertText,
								},
								kind: 20 satisfies typeof vscode.CompletionItemKind.EnumMember,
							};

							completionList.items.push(newItem);
						}
					}
				}

				for (const item of completionList.items) {

					const itemIdKey = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
					const itemId = itemIdKey ? readInternalItemId(itemIdKey) : undefined;

					if (itemId) {
						item.documentation = undefined;
					}

					if (item.kind === 10 satisfies typeof vscode.CompletionItemKind.Property && componentNames.has(hyphenateTag(item.label))) {
						item.kind = 6 satisfies typeof vscode.CompletionItemKind.Variable;
						item.sortText = '\u0000' + (item.sortText ?? item.label);
					}
					else if (itemId && (itemId.type === 'componentProp' || itemId.type === 'componentEvent')) {

						const [componentName] = itemId.args;

						if (componentName !== '*') {
							item.sortText = '\u0000' + (item.sortText ?? item.label);
						}

						if (itemId.type === 'componentProp') {
							if (componentName !== '*') {
								item.kind = 5 satisfies typeof vscode.CompletionItemKind.Field;
							}
						}
						else {
							item.kind = componentName !== '*' ? 3 satisfies typeof vscode.CompletionItemKind.Function : 23 satisfies typeof vscode.CompletionItemKind.Event;
						}
					}
					else if (
						item.label === 'v-if'
						|| item.label === 'v-else-if'
						|| item.label === 'v-else'
						|| item.label === 'v-for'
					) {
						item.kind = 14 satisfies typeof vscode.CompletionItemKind.Keyword;
						item.sortText = '\u0003' + (item.sortText ?? item.label);
					}
					else if (item.label.startsWith('v-')) {
						item.kind = 3 satisfies typeof vscode.CompletionItemKind.Function;
						item.sortText = '\u0002' + (item.sortText ?? item.label);
					}
					else {
						item.sortText = '\u0001' + (item.sortText ?? item.label);
					}
				}

				options.updateCustomData(baseServiceInstance, []);
			}
		},
	};
};

function createInternalItemId(type: 'componentEvent' | 'componentProp', args: string[]) {
	return '__VLS_::' + type + '::' + args.join(',');
}

function readInternalItemId(key: string) {
	if (key.startsWith('__VLS_::')) {
		const strs = key.split('::');
		return {
			type: strs[1] as 'componentEvent' | 'componentProp',
			args: strs[2].split(','),
		};
	}
}

function getReplacement(list: html.CompletionList, doc: TextDocument) {
	for (const item of list.items) {
		if (item.textEdit && 'range' in item.textEdit) {
			return {
				item: item,
				textEdit: item.textEdit,
				text: doc.getText(item.textEdit.range)
			};
		}
	}
}
