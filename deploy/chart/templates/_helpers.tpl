{{- define "m365c.websiteLabels" -}}
app.kubernetes.io/name: m365-configurator
app.kubernetes.io/component: website
{{- end -}}

{{- define "m365c.apiLabels" -}}
app.kubernetes.io/name: m365-configurator
app.kubernetes.io/component: api
{{- end -}}
