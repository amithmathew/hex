import * as vscode from 'vscode';
import { Hex } from './Hex';
import { HexLogger } from './HexLogger';

/*** Initialize logger */
export const hexlogger = new HexLogger();

export function activate(context: vscode.ExtensionContext) {
    /**** Constants */
    const HEX_URI_PATH_PREFIX='hex-suggestion-diff';

    /**** Variables */
    let hex = new Hex(context);
    hex.initialize();

    let hexModifyCodeSessionContext:
        {
            originalEditor: vscode.TextEditor,
            originalCodeRange: vscode.Range,
            originalCode: string,
            modifiedCode: string,
            modifiedCodeDoc: vscode.TextDocument | null
            modifiedCodeDocEditor: vscode.TextEditor | null
        } | null = null;

    // DEPRECATED Module level variable to track if hexdiff is open
    let hexDiffViewOpen = false;

    // Module level variable to avoid recursive event handling when
    // closing hex window.
    let hexDiffIsClosing = false;

    /**** Secrets */
    /**** TODO: Make more generic */
    context.secrets.get('hexOpenAIKey').then(apiKey => {
		if (!apiKey) {
			// Prompt user to enter API Key
			vscode.window.showInputBox({
				prompt: "If you plan to use OpenAI, and do not have your OpenAI API Key stored in an environment variable called OPENAI_API_KEY, please enter it here. Otherwise leave blank.",
				placeHolder: "",
				ignoreFocusOut: true
			}).then(key => {
				if (key) {
					// Save the API key using the Secrets API
					context.secrets.store('hexOpenAIKey', key).then(() => {
						vscode.window.showInformationMessage("Key saved securely.");
					});
				}
			});
		}
	});

    /**** Helper Functions */

    // Any configuration changes should reload the extension and recreate objects
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration("hex")) {
			// Handle the configuration change
			hex = new Hex(context);
            hex.initialize();
		}
	}));

    // Custom content provider for the virtual-doc scheme for diffing
    const diffStaticContentProvider = new (class implements vscode.TextDocumentContentProvider {
		// Emits events when the document content is changed
		onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
		onDidChange = this.onDidChangeEmitter.event;

		contentMap = new Map<string, string>();

		provideTextDocumentContent(uri: vscode.Uri): string {
			return this.contentMap.get(uri.toString()) || '';
		}

		updateContent(uri: vscode.Uri, content: string) {
			this.contentMap.set(uri.toString(), content);
			this.onDidChangeEmitter.fire(uri);
		}
	})();
	vscode.workspace.registerTextDocumentContentProvider(HEX_URI_PATH_PREFIX, diffStaticContentProvider);

    // Close and cleanup open Hex windows and objects
    async function closeHexAndCleanup() {
        // Close all untitled documents related to the diff operation

        // Let's retrieve all text editors
        const document = vscode.workspace.textDocuments.find(
            doc => doc.uri.path.startsWith(HEX_URI_PATH_PREFIX + '/') && doc.uri.scheme === 'untitled'
		);
		
		if(!document) {
            hexlogger.log("Couldn't find modified buffer to revert and close.");
		} else {
            hexlogger.log('Trying to revert and close modified buffer');
            try {
                await vscode.window.showTextDocument(document, { preserveFocus: false });
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            } catch {
                hexlogger.log("Could not revert and close modified buffer.");
            }
        }

        // Attempt to refocus the original editor if it's still available
		if (hexModifyCodeSessionContext && hexModifyCodeSessionContext.originalEditor) {
			try {
				await vscode.window.showTextDocument(hexModifyCodeSessionContext.originalEditor.document, { preview: false, viewColumn: hexModifyCodeSessionContext.originalEditor.viewColumn });
			}
			catch {
				hexlogger.log("Couldn't find the original editor to revert to.");
			}
		} else {
			// Optionally handle the case where the original editor might have been closed or is no longer accessible
			vscode.window.showInformationMessage("Hex: Original document is no longer open!");
		}
		hexModifyCodeSessionContext = null;
        // Resetting the context variable.
		await vscode.commands.executeCommand('setContext', 'hexSuggDiffViewOpen', false);
		hexDiffViewOpen = false;
    }

    // Monitor VisibleTextEditors list change to detect if Hex tabs were closed.
    // Revert all changes and close Hex buffers if so.
    let tabCloseTriggerDisposable = vscode.window.onDidChangeVisibleTextEditors(
        async editors => {
            if (!hexDiffViewOpen) {
                //hexlogger.log("Hex: VisibleTextEditors changed, but no diff view open. Returning.");
			    return;
            }
            if (hexDiffIsClosing) {
                console.log("Hex: Avoiding recursive event handling. Hex Diff is closing!");
                return;
            }
            hexlogger.log("Hex: Visible tabs have changed, checking hex diff tab was closed.");
            let hexdiffFound = false;
            let hexModifiedEditorFound = false;
		    vscode.window.tabGroups.all.forEach((tg) => {
			    tg.tabs.forEach((t) => {
                    const tabInput = t.input? t.input as vscode.TabInputText: undefined;
				    if (t.label === 'Hex: Suggested Changes') {
					    // Returns true if it's a diff view.
                        hexdiffFound = t.input instanceof vscode.TabInputTextDiff; 
				    }
                    if (tabInput && tabInput.uri && tabInput.uri.path === HEX_URI_PATH_PREFIX + '/modified') {
                        hexModifiedEditorFound = true;
                    }
				    //console.log(t.input instanceof vscode.TabInputTextDiff);
			    });
		    });
		    if ((!hexdiffFound || !hexModifiedEditorFound) && hexDiffViewOpen) {
			    // No Hex Diff window open. It's been closed. Let's cleanup
			    hexDiffIsClosing = true; // Set flag to avoid recursive calls
			    await closeHexAndCleanup();
			    hexDiffIsClosing = false; // Reset flag after cleanup
			    hexDiffViewOpen = false;
			    hexlogger.log("Hex: Diff is closed and windows cleaned up!");
		    }
        }
    );
    context.subscriptions.push(tabCloseTriggerDisposable);

    // Abort controller
    let requestAbortController = new AbortController();
    let { signal } = requestAbortController;

    /**** Hex Commands */
    let abortSignalCommand = vscode.commands.registerCommand('hex.abort',
        async () => {
            requestAbortController.abort();
            requestAbortController = new AbortController();
            signal = requestAbortController.signal;
        }
    );
    context.subscriptions.push(abortSignalCommand);

    // Prompt and then modify code selection
    let modifyCodeDisposable = vscode.commands.registerCommand('hex.modifyCode',
        async () => {
            // Is this the first Hex call, or are we finetuning a suggestion?
            let fineTuneMode = false;
            let promptTitle = "Hex: Instructions";

            if (hexModifyCodeSessionContext) {
                // This means we're in finetune mode.
                fineTuneMode = true;
                hexlogger.log("Finetune mode.");
                promptTitle = "Hex: Finetune";
            }

            // Prompt user for instructions
            vscode.window.showInputBox({
                prompt: 'Enter Prompt:',
                title: promptTitle
            }).then(
                async prompt => {
                    if (!prompt) {
                        hexlogger.log('No prompt specified.');
                        return;
                    }

                    let suggestedText: any;

                    if (fineTuneMode) {
                        if (!hexModifyCodeSessionContext) {
                            hexlogger.log("Something went wrong. We're in finetune mode, but no hexModifySessionContext");
                            return;
                        }
                        // We should already have hexModifyCodeSessionContext
                        // Let's get the last modified text from the modified editor
                        let modifiedText = hexModifyCodeSessionContext.modifiedCodeDoc?.getText();
                        const modifiedDoc = hexModifyCodeSessionContext.modifiedCodeDoc;
                        const modifiedDocEditor = await vscode.window.visibleTextEditors.find(
                            (editor) => editor.document === modifiedDoc
                        );
                        if (modifiedDocEditor) {
                            hexModifyCodeSessionContext.modifiedCodeDocEditor = modifiedDocEditor;
                        }

                        // Send for finetuning
                        let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
                        statusBarItem.text = "$(loading~spin) Hex is working...";
                        statusBarItem.tooltip = "Click to cancel current operation.";
                        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                        statusBarItem.command = 'hex.abort';
                        statusBarItem.show();
                        try {
                            suggestedText = await hex.modifyCode({ signal }, prompt, modifiedText!, hexModifyCodeSessionContext!.originalCode);
                            statusBarItem.text = "$(check) Hex is done.";
                            statusBarItem.tooltip = "Operation completed.";
                            statusBarItem.backgroundColor = undefined;
                        } catch (error) {
                            statusBarItem.text = "$(error) Request aborted.";
                            statusBarItem.tooltip = undefined;
                            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                            statusBarItem.command = undefined;
                            setTimeout(() => statusBarItem.hide(), 5000);
                            throw error;
                        }
                        statusBarItem.command = undefined;
                        setTimeout(() => statusBarItem.hide(), 5000);

                        // Let's update the modified editor with the new suggestion
					    await modifiedDocEditor!.edit(editBuilder => {
						    // Replace everything from the start to the end of the document with suggestedText
						    const entireRange = new vscode.Range(
							    modifiedDoc!.lineAt(0).range.start,
							    modifiedDoc!.lineAt(modifiedDoc!.lineCount - 1).range.end
						    );
						    editBuilder.replace(entireRange, suggestedText);
					    });

                        // Set hexModifySessionContext to use in acceptSuggestion command.
					    hexModifyCodeSessionContext!.modifiedCode = suggestedText;
                    } 
                    else {
                        const editor = vscode.window.activeTextEditor;
                        if (!editor) {
                            vscode.window.showErrorMessage('Hex: No active editor.');
                            return;
                        }
                        const document = editor.document;
                        if (!document) {
                            hexlogger.log("Found an editor, but no document found???");
                            return;
                        }
                        const selection = editor.selection;
                        if (!selection) {
                            hexlogger.log("Hex called, but nothing selected.");
                            vscode.window.showWarningMessage('Hex: No selection detected.');
                            return;
                        }

                        // Modify user's selection to include the entire start line and end line.
                        // and get the selection
                        const endLine = document.lineAt(selection.end.line);
                        const fullSelection = new vscode.Range(
                            new vscode.Position(selection.start.line, 0), // Start from the beginning of the line
                            new vscode.Position(selection.end.line, endLine.range.end.character) // End at the last character of the end line
                        );
                        const selectedText = document.getText(fullSelection);

                        // Start processing the selection
                        let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
                        statusBarItem.text = "$(loading~spin) Hex is working...";
                        statusBarItem.tooltip = "Click to cancel current operation.";
                        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                        statusBarItem.command = 'hex.abort';
                        statusBarItem.show();
                        try {
                            suggestedText = await hex.modifyCode({ signal }, prompt, selectedText);
                            statusBarItem.text = "$(check) Hex is done.";
                            statusBarItem.tooltip = "Operation completed.";
                            statusBarItem.backgroundColor = undefined;
                        } catch (error) {
                            statusBarItem.text = "$(error) Request aborted.";
                            statusBarItem.tooltip = undefined;
                            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                            statusBarItem.command = undefined;
                            setTimeout(() => statusBarItem.hide(), 5000);
                            throw error;
                        }
                        
                        statusBarItem.command = undefined;
                        setTimeout(() => statusBarItem.hide(), 5000);

                        // Setup the hexModifyCodeSessionContext
                        hexModifyCodeSessionContext =
                        {
                            "originalEditor": editor,
                            "originalCodeRange": selection,
                            "originalCode": selectedText,
                            "modifiedCode": suggestedText,
                            "modifiedCodeDoc": null,
                            "modifiedCodeDocEditor": null,
                        };

                        // Setup for the diff view
                        const originalUri = vscode.Uri.parse(HEX_URI_PATH_PREFIX + ':/original');
                        const modifiedUri = vscode.Uri.parse('untitled:' + HEX_URI_PATH_PREFIX + '/modified');
                        diffStaticContentProvider.updateContent(originalUri, selectedText);
                        const rightDoc = await vscode.workspace.openTextDocument(modifiedUri);
                        const rightDocEditor = await vscode.window.showTextDocument(
                                rightDoc, 
                                { 
                                    viewColumn: vscode.ViewColumn.One, 
                                    preserveFocus: true 
                                }
                        ); // Show right side first
                        
                        // Capture the modified code diff editor object
                        hexModifyCodeSessionContext.modifiedCodeDoc = rightDoc;
                        hexModifyCodeSessionContext.modifiedCodeDocEditor = rightDocEditor;


                        // Let's add suggested text to the right doc.
                        await rightDocEditor.edit(editBuilder => {
                            // Replace everything from the start to the end of the document with suggestedText
                            const entireRange = new vscode.Range(
                                rightDoc.lineAt(0).range.start,
                                rightDoc.lineAt(rightDoc.lineCount - 1).range.end
                            );
                            editBuilder.replace(entireRange, suggestedText);
                        });


                        // Open the diff view
                        await vscode.commands.executeCommand('vscode.diff', 
                            originalUri, 
                            rightDoc.uri, 
                            "Hex: Suggested Changes");

                        // Setting context to enable accept and reject editor icons
                        hexDiffViewOpen = true;
                        await vscode.commands.executeCommand('setContext', 'hexSuggDiffViewOpen', true);
                    }
                }
            );
        }
    );
    context.subscriptions.push(modifyCodeDisposable);
    
    // Accept code modifications and apply them
    let acceptSuggestionDisposable = vscode.commands.registerCommand('hex.acceptSuggestion',
        async () => {
            // Make sure we have hexModifyCodeSessionContext
            if (!hexModifyCodeSessionContext 
                || !hexModifyCodeSessionContext.originalEditor
                || !hexModifyCodeSessionContext.originalCodeRange)
                {
                    vscode.window.showErrorMessage('Hex: Could not find original editor references to apply suggestion to.');
                    hexlogger.log('hexModifyCodeSessionContext or originalEditor related references are missing.');
                    return;
                }

            // Update the hexModifyCodeSessionContext with the latest value in the modified editor.
            hexModifyCodeSessionContext.modifiedCode = hexModifyCodeSessionContext.modifiedCodeDoc?.getText()!;

            // Get the full line that includes the start of the original range.
            const originalFullStartLine = hexModifyCodeSessionContext
                                            .originalEditor.document
                                            .lineAt(
                                                hexModifyCodeSessionContext
                                                    .originalCodeRange
                                                    .start
                                                    .line
                                            );
            const originalFullStartLineText = originalFullStartLine.text;

            // Extract the leading whitespace from the full line and apply to the
            // modified code
            const leadingWhitespaceMatch = originalFullStartLineText
                                                .match(/^(\s*)/);
			const leadingWhitespace = leadingWhitespaceMatch ? 
                                        leadingWhitespaceMatch[1] : '';
            
            // Adjust the originalCodeRange to include the full line if not already included
			const newRange = new vscode.Range(
				new vscode.Position(hexModifyCodeSessionContext
                                        .originalCodeRange.start.line, 
                                    0), // Start from the beginning of the line
				hexModifyCodeSessionContext.originalCodeRange.end
			);

            // Prepare the modified code with the original leading whitespace.
            // TODO: This needs to be reviewed.
			const modifiedTextWithIndentation = hexModifyCodeSessionContext
                                .modifiedCode
                                .split('\n')  // Split the modified code into lines
                                .map((line) => leadingWhitespace + line)
                                .join('\n');  // Rejoin the lines into a single string
            
            // Create a new selection to span the modified code
			// Split new content into lines once and reuse the result
			const modifiedCodeLines = hexModifyCodeSessionContext
                                        .modifiedCode.split('\n');
			const modifiedCodeNumLines = modifiedCodeLines.length;
			// Safely get the last line with default fallback
            const modifiedCodeLastLine = modifiedCodeLines.pop() || '';  
			// Calculate the end position based on whether the new content is single-line or multi-line
			const newModifiedCodeEndLine = hexModifyCodeSessionContext
                        .originalCodeRange.start.line + modifiedCodeNumLines;
			const newModifiedCodeEndCharacter = 
                newModifiedCodeEndLine === hexModifyCodeSessionContext
                                                .originalCodeRange
                                                .start.line
				    ? hexModifyCodeSessionContext.originalCodeRange
                                                    .start.character 
                        + modifiedCodeLastLine.length
				    : modifiedCodeLastLine.length;
			const newModifiedCodeEndPosition = new vscode.Position(
                                        newModifiedCodeEndLine, 
                                        newModifiedCodeEndCharacter);
			const newModifiedCodeSelection = new vscode.Selection(
                            hexModifyCodeSessionContext.originalCodeRange.start, 
                            newModifiedCodeEndPosition);

			//hexlogger.log("Selection correction.");
			//hexlogger.log("modifiedselection start " + hexModifyCodeSessionContext.originalCodeRange.start);
			//hexlogger.log("originalCode end line" + hexModifyCodeSessionContext.originalCodeRange.end.line);
			//hexlogger.log("modifiedselection end line " + newModifiedCodeEndLine);


			// Create a workspace edit to apply the changes
			const workspaceEdit = new vscode.WorkspaceEdit();
			workspaceEdit.replace(
				hexModifyCodeSessionContext.originalEditor.document.uri,
				newRange,
				modifiedTextWithIndentation
			);

			// Apply the workspace edit.
			vscode.workspace.applyEdit(workspaceEdit)
				.then(success => {
					if (success) {
                        setTimeout(() => {
                            // Update the selection to span the modified code that was inserted.
                            hexModifyCodeSessionContext!.originalEditor.selection = newModifiedCodeSelection;
                            hexModifyCodeSessionContext!.originalEditor.selections 
                                    = [newModifiedCodeSelection];
                        }, 0);
						vscode.window.showInformationMessage('Hex: Applied code suggestion.');
					} else {
						vscode.window
                            .showErrorMessage('Hex: Failed to apply suggestion. Something went wrong.');
					}
				});

			await closeHexAndCleanup();
        }
    );
    context.subscriptions.push(acceptSuggestionDisposable);

    console.log('"Hex" is now active!');

}

export function deactivate() { 
    console.log("Hex says bye bye!");
}