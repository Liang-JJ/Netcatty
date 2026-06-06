import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useRef, useState } from "react";

import { logger } from "../../../lib/logger";
import { extractDropEntries, getPathForFile } from "../../../lib/sftpFileUtils";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { Host, TerminalSession } from "../../../types";
import { toast } from "../../ui/toast";
import {
  extractRootPathsFromDropEntries,
  type TerminalProps,
} from "../terminalHelpers";

interface UseTerminalDragDropOptions {
  host: Host;
  isLocalConnection: boolean;
  isZmodemUploadMode: boolean;
  onOpenSftp?: TerminalProps["onOpenSftp"];
  resolveSftpInitialPath: () => Promise<string | undefined>;
  scrollToBottomAfterProgrammaticInput: (data: string) => void;
  sessionId: string;
  sessionRef: React.MutableRefObject<string | null>;
  status: TerminalSession["status"];
  t: (key: string) => string;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  };
  termRef: React.MutableRefObject<XTerm | null>;
}

export function useTerminalDragDrop({
  host,
  isLocalConnection,
  isZmodemUploadMode,
  onOpenSftp,
  resolveSftpInitialPath,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  sessionRef,
  status,
  t,
  terminalBackend,
  termRef,
}: UseTerminalDragDropOptions) {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDraggingOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    if (!e.dataTransfer.types.includes("Files")) {
      return;
    }

    if (status !== "connected") {
      toast.error(t("terminal.dragDrop.notConnected"), t("terminal.dragDrop.errorTitle"));
      return;
    }

    // Snapshot the FileList BEFORE extractDropEntries — webkitGetAsEntry()
    // consumes the DataTransfer items, making .files empty afterwards.
    const droppedFiles: File[] = [];
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      droppedFiles.push(e.dataTransfer.files[i]);
    }

    try {
      const dropEntries = await extractDropEntries(e.dataTransfer);

      if (dropEntries.length === 0) {
        return;
      }

      if (isLocalConnection) {
        const paths = extractRootPathsFromDropEntries(dropEntries);

        if (paths.length > 0 && termRef.current && sessionRef.current) {
          const pathsText = paths.join(" ");
          terminalBackend.writeToSession(sessionRef.current, pathsText);
          scrollToBottomAfterProgrammaticInput(pathsText);
          termRef.current.focus();
        }
      } else if (isZmodemUploadMode) {
        // Zmodem upload mode: collect absolute file paths, send them to the
        // main process so handleUpload can skip the file dialog, then write
        // "rz -E" to the terminal to trigger the remote zmodem receive.
        const sid = sessionRef.current || sessionId;
        if (!sid || droppedFiles.length === 0) {
          toast.error("Zmodem: 无活跃会话或无拖放文件", "Zmodem 上传失败");
          return;
        }

        const filePaths: string[] = [];
        for (const file of droppedFiles) {
          const fp = getPathForFile(file);
          if (fp) filePaths.push(fp);
        }

        if (filePaths.length === 0) {
          const hasGetPath = !!netcattyBridge.get()?.getPathForFile;
          const names = droppedFiles.map(f => f.name).join(", ");
          toast.error(
            `Zmodem: 无法解析文件路径 (${droppedFiles.length}个文件: ${names})。` +
            `getPathForFile 可用: ${hasGetPath}`,
            "Zmodem 上传失败"
          );
          return;
        }

        const bridge = netcattyBridge.get();
        bridge?.setPendingZmodemUpload?.(sid, filePaths);
        const cmd = "rz -E\r";
        terminalBackend.writeToSession(sid, cmd);
        scrollToBottomAfterProgrammaticInput(cmd);
        termRef.current?.focus();
      } else if (onOpenSftp) {
        const initialPath = await resolveSftpInitialPath();
        onOpenSftp(host, initialPath, dropEntries, sessionId);
      }
    } catch (error) {
      logger.error("Failed to handle file drop", error);
      toast.error(t("terminal.dragDrop.errorMessage"), t("terminal.dragDrop.errorTitle"));
    }
  };

  return {
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    isDraggingOver,
  };
}
