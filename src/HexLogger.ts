import * as vscode from 'vscode';


// HexLogger
export class HexLogger {

    private outputChannel: vscode.OutputChannel;
    private loglevel: string;
    private writeToStdout: boolean;

    constructor(loglevel="DEBUG", writeToStdout=true) {
        this.outputChannel = vscode.window.createOutputChannel('Hex');
        this.loglevel = loglevel;
        this.writeToStdout = writeToStdout;
    }

    public async log(logstring: string, loglevel="DEBUG") {
        this.outputChannel.append(logstring + '\n');
        if (this.writeToStdout === true) {
            console.log('Hex: ' + logstring);
        }
    }
}