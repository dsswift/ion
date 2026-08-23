import Foundation

extension SessionViewModel {
    /// Requests an exact task stop. The task stays visible until engine truth
    /// removes it through a lifecycle event or status snapshot.
    @MainActor
    func stopBackgroundTask(tabId: String, taskId: String) {
        guard !stoppingBackgroundTaskIds.contains(taskId) else { return }
        let requestId = UUID().uuidString
        stoppingBackgroundTaskIds.insert(taskId)
        DiagnosticLog.log("background task stop requested", tag: "session.background", fields: [
            "tab_id": tabId,
            "task_id": taskId,
            "request_id": requestId,
        ])
        send(.stopBackgroundTask(tabId: tabId, taskId: taskId, requestId: requestId), intent: .userInitiated)
    }

    @MainActor
    func handleBackgroundTaskStarted(
        tabId: String,
        instanceId: String?,
        task: BackgroundTaskState
    ) {
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { instance in
            var tasks = instance.activeBackgroundTasks ?? instance.statusFields?.activeBackgroundTasks ?? []
            tasks.removeAll { $0.taskId == task.taskId }
            tasks.append(task)
            tasks.sort { $0.startedAt == $1.startedAt ? $0.taskId < $1.taskId : $0.startedAt < $1.startedAt }
            instance.activeBackgroundTasks = tasks
            instance.statusFields?.activeBackgroundTasks = tasks
        }
        DiagnosticLog.log("background task started", tag: "session.background", fields: [
            "tab_id": tabId,
            "task_id": task.taskId,
            "status": task.notifyOnComplete ? "notify" : "detached",
        ])
    }

    @MainActor
    func handleBackgroundTaskTerminal(
        tabId: String,
        instanceId: String?,
        taskId: String,
        status: String
    ) {
        stoppingBackgroundTaskIds.remove(taskId)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { instance in
            instance.activeBackgroundTasks?.removeAll { $0.taskId == taskId }
            instance.statusFields?.activeBackgroundTasks?.removeAll { $0.taskId == taskId }
            for index in instance.messages.indices where instance.messages[index].backgroundTaskId == taskId {
                instance.messages[index].toolStatus = status == "completed" ? .completed : .error
            }
        }
        DiagnosticLog.log("background task terminal", tag: "session.background", fields: [
            "tab_id": tabId,
            "task_id": taskId,
            "status": status,
        ])
    }

    @MainActor
    func handleBackgroundTaskStopResult(
        requestId: String,
        taskId: String,
        status: String,
        error: String?
    ) {
        stoppingBackgroundTaskIds.remove(taskId)
        guard status != "stopped" else {
            DiagnosticLog.log("background task stop accepted", tag: "session.background", fields: [
                "task_id": taskId,
                "request_id": requestId,
            ])
            return
        }
        let detail = error ?? "The task could not be stopped (\(status))."
        DiagnosticLog.log("background task stop refused", tag: "session.background", level: .error, fields: [
            "task_id": taskId,
            "request_id": requestId,
            "status": status,
            "error": detail,
        ])
        showToast(ToastMessage(style: .error, title: "Stop failed", detail: detail))
    }
}
