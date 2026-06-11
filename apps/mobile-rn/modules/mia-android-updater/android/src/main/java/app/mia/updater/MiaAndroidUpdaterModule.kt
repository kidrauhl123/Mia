package app.mia.updater

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class MiaAndroidUpdaterModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("MiaAndroidUpdater")

    AsyncFunction("canRequestPackageInstalls") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
    }

    AsyncFunction("openUnknownSourcesSettings") {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    AsyncFunction("inspectApk") { localUri: String ->
      val apkFile = fileFromUri(localUri)
      val info = packageInfoForArchive(apkFile)
      mapOf(
        "packageName" to (info.packageName ?: ""),
        "versionCode" to longVersionCode(info).toDouble(),
        "versionName" to (info.versionName ?: "")
      )
    }

    AsyncFunction("installApk") { localUri: String ->
      val apkFile = fileFromUri(localUri)
      if (!apkFile.exists()) throw CodedException("APK file does not exist: ${apkFile.absolutePath}")
      val authority = "${context.packageName}.mia_update_file_provider"
      val contentUri = FileProvider.getUriForFile(context, authority, apkFile)
      val intent = Intent(Intent.ACTION_INSTALL_PACKAGE)
        .setData(contentUri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }

  private fun fileFromUri(localUri: String): File {
    val uri = Uri.parse(localUri)
    if (uri.scheme != "file") throw CodedException("Only file:// APK URIs are supported.")
    val path = uri.path ?: throw CodedException("APK URI is missing a path.")
    val file = File(path)
    if (!file.exists()) throw CodedException("APK file does not exist: $path")
    return file
  }

  private fun packageInfoForArchive(apkFile: File): PackageInfo {
    val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getPackageArchiveInfo(apkFile.absolutePath, PackageManager.PackageInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getPackageArchiveInfo(apkFile.absolutePath, 0)
    }
    return info ?: throw CodedException("Unable to inspect APK package info.")
  }

  private fun longVersionCode(info: PackageInfo): Long {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.longVersionCode
    } else {
      @Suppress("DEPRECATION")
      info.versionCode.toLong()
    }
  }
}
