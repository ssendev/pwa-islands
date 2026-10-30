package dev.ssen.pwaislands

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class FolderPickerPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun pickFolder(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
          data = Uri.parse("package:" + activity.packageName)
        }
        startActivityForResult(invoke, intent, "manageStorageResult")
        return
      }

      launchFolderPicker(invoke)
    } catch (e: Exception) {
      invoke.reject("Fehler beim Starten der Ordnerauswahl: ${e.message}")
    }
  }

  @ActivityCallback
  fun manageStorageResult(invoke: Invoke, result: ActivityResult) {
    launchFolderPicker(invoke)
  }

  private fun launchFolderPicker(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
          Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        )
      }
      startActivityForResult(invoke, intent, "folderPickerResult")
    } catch (e: Exception) {
      invoke.reject("Fehler beim Öffnen des Ordnerauswahldialogs: ${e.message}")
    }
  }

  @ActivityCallback
  fun folderPickerResult(invoke: Invoke, result: ActivityResult) {
    try {
      if (result.resultCode == Activity.RESULT_OK) {
        val uri: Uri? = result.data?.data
        if (uri == null) {
          val ret = JSObject()
          ret.put("path", null)
          invoke.resolve(ret)
          return
        }

        try {
          val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
          activity.contentResolver.takePersistableUriPermission(uri, takeFlags)
        } catch (_: Exception) {
          // Best-effort: nicht alle Provider unterstützen persistable permissions
        }

        val resolvedPath = resolveTreeUriToPath(uri)
        if (resolvedPath == null) {
          invoke.reject("Der gewählte Ordner konnte nicht aufgelöst werden. Bitte wählen Sie einen lokalen Ordner auf dem Gerätespeicher.")
          return
        }

        val ret = JSObject()
        ret.put("path", resolvedPath)
        invoke.resolve(ret)
      } else {
        val ret = JSObject()
        ret.put("path", null)
        invoke.resolve(ret)
      }
    } catch (e: Exception) {
      invoke.reject("Fehler bei der Ordnerauswertung: ${e.message}")
    }
  }

  private fun resolveTreeUriToPath(uri: Uri): String? {
    if (DocumentsContract.isTreeUri(uri)) {
      val docId = DocumentsContract.getTreeDocumentId(uri)
      val split = docId.split(":")
      val type = split[0]
      val subPath = if (split.size > 1) split[1].trimStart('/') else ""
      if ("primary".equals(type, ignoreCase = true)) {
        val base = Environment.getExternalStorageDirectory().absolutePath
        return if (subPath.isNotEmpty()) "$base/$subPath" else base
      } else {
        val base = "/storage/$type"
        return if (subPath.isNotEmpty()) "$base/$subPath" else base
      }
    } else if ("file".equals(uri.scheme, ignoreCase = true)) {
      return uri.path
    }
    return null
  }
}
