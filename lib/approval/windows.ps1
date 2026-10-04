# UI only: all command execution and approval state belong to the Node parent.
param([switch]$Validate)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
public static class ApprovalInput {
    public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static volatile bool Ended;
    public static void Start() {
        var thread = new Thread(() => {
            try {
                using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) {
                    string line;
                    while ((line = reader.ReadLine()) != null) Lines.Enqueue(line);
                }
            } finally { Ended = true; }
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
'@
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [xml]$layout = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="gitbash-mcp | Command approvals" Width="760" Height="540"
        MinWidth="560" MinHeight="360" WindowStartupLocation="CenterScreen"
        WindowStyle="None" ResizeMode="CanResizeWithGrip"
        Background="#eff1f5" Foreground="#4c4f69" FontFamily="Segoe UI" FontSize="14">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Padding" Value="18,10"/>
      <Setter Property="Margin" Value="8,0,0,0"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="ButtonSurface" CornerRadius="5"
                    Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" RecognizesAccessKey="True"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="ButtonSurface" Property="Opacity" Value="0.85"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="ButtonSurface" Property="Opacity" Value="0.65"/>
              </Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True">
                <Setter TargetName="ButtonSurface" Property="BorderBrush" Value="#1e66f5"/>
                <Setter TargetName="ButtonSurface" Property="BorderThickness" Value="1"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="ButtonSurface" Property="Opacity" Value="0.4"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>
    <Border x:Name="TitleBar" Background="Transparent" Padding="24,24,24,20">
      <Grid>
      <StackPanel HorizontalAlignment="Center" VerticalAlignment="Center" IsHitTestVisible="False">
        <TextBlock Text="Command approvals" FontSize="25" FontWeight="SemiBold" HorizontalAlignment="Center"/>
        <TextBlock Text="gitbash-mcp" FontSize="14" FontWeight="Medium" Foreground="#6c6f85" Margin="0,5,0,0" HorizontalAlignment="Center"/>
      </StackPanel>
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Top">
        <Button x:Name="Minimize" Content="&#x2212;" ToolTip="Minimize"
                Background="#ccd0da" Foreground="#4c4f69" BorderThickness="0" Padding="12,6"/>
        <Button x:Name="Close" Content="&#x00D7;" ToolTip="Close"
                Background="#ccd0da" Foreground="#4c4f69" BorderThickness="0" Padding="12,6"/>
      </StackPanel>
      </Grid>
    </Border>
    <ScrollViewer Grid.Row="1" Margin="24,0,24,0" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
      <StackPanel>
        <TextBlock Text="Command" Foreground="#6c6f85" Margin="0,0,0,8"/>
        <Border Background="#e6e9ef" CornerRadius="8" Padding="16">
          <StackPanel>
            <ScrollViewer x:Name="CommandView" MaxHeight="48" VerticalScrollBarVisibility="Disabled" HorizontalScrollBarVisibility="Disabled">
              <TextBlock x:Name="Command" FontFamily="Consolas" TextWrapping="Wrap" LineHeight="24" LineStackingStrategy="BlockLineHeight"/>
            </ScrollViewer>
            <Button x:Name="ExpandCommand" Content="Expand" Visibility="Collapsed" HorizontalAlignment="Left"
                    Background="Transparent" Foreground="#1e66f5" BorderThickness="0" Padding="0,8,0,0" Margin="0"/>
          </StackPanel>
        </Border>
        <TextBlock Text="Working directory" Foreground="#6c6f85" Margin="0,20,0,8"/>
        <Border Background="#e6e9ef" CornerRadius="8" Padding="16">
          <StackPanel>
            <ScrollViewer x:Name="DirectoryView" MaxHeight="48" VerticalScrollBarVisibility="Disabled" HorizontalScrollBarVisibility="Disabled">
              <TextBlock x:Name="Directory" TextWrapping="Wrap" LineHeight="24" LineStackingStrategy="BlockLineHeight"/>
            </ScrollViewer>
            <Button x:Name="ExpandDirectory" Content="Expand" Visibility="Collapsed" HorizontalAlignment="Left"
                    Background="Transparent" Foreground="#1e66f5" BorderThickness="0" Padding="0,8,0,0" Margin="0"/>
          </StackPanel>
        </Border>
        <TextBlock Text="Options" Foreground="#6c6f85" Margin="0,20,0,8"/>
        <Border Background="#e6e9ef" CornerRadius="8" Padding="16">
          <TextBlock x:Name="Options" TextWrapping="Wrap" LineHeight="24" LineStackingStrategy="BlockLineHeight"/>
        </Border>
      </StackPanel>
    </ScrollViewer>
    <Grid Grid.Row="2" Margin="24,20,24,24">
      <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
      <StackPanel Grid.Column="1" Orientation="Horizontal" HorizontalAlignment="Center" VerticalAlignment="Center">
        <Button x:Name="Previous" Content="&lt;" IsEnabled="False" Margin="0"
                Background="#ccd0da" Foreground="#4c4f69" BorderThickness="0"/>
        <TextBlock x:Name="Position" Text="0 / 0" Margin="16,0" VerticalAlignment="Center"/>
        <Button x:Name="Next" Content="&gt;" IsEnabled="False" Margin="0"
                Background="#ccd0da" Foreground="#4c4f69" BorderThickness="0"/>
      </StackPanel>
      <StackPanel Grid.Column="2" Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
        <Button x:Name="Reject" Content="Reject" IsDefault="True" IsEnabled="False" Padding="12,10"
                Background="#ccd0da" Foreground="#4c4f69" BorderThickness="0"/>
        <Button x:Name="Approve" Content="Approve" IsEnabled="False" Padding="12,10"
                Background="#1e66f5" Foreground="#eff1f5" BorderThickness="0"/>
      </StackPanel>
    </Grid>
  </Grid>
</Window>
'@
    $reader = New-Object System.Xml.XmlNodeReader($layout)
    $script:Window = [Windows.Markup.XamlReader]::Load($reader)
    $script:Requests = @()
    $script:SelectedIndex = -1
    $script:Command = $script:Window.FindName('Command')
    $script:Directory = $script:Window.FindName('Directory')
    $script:Options = $script:Window.FindName('Options')
    $script:DisplayedId = $null
    $script:Expanded = @{ Command = $false; Directory = $false }
    $script:Previous = $script:Window.FindName('Previous')
    $script:Next = $script:Window.FindName('Next')
    $script:Position = $script:Window.FindName('Position')
    $script:Approve = $script:Window.FindName('Approve')
    $script:Reject = $script:Window.FindName('Reject')
    $script:Submitted = @{}

    function Send-Reply($reply) {
        [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 8))
        [Console]::Out.Flush()
    }
    function Show-Selection {
        $item = Get-Selection
        $currentId = if ($null -ne $item) { $item.approval_id } else { $null }
        if ($currentId -ne $script:DisplayedId) {
            $script:Expanded.Command = $false
            $script:Expanded.Directory = $false
            $script:DisplayedId = $currentId
            $script:Window.FindName('CommandView').ScrollToTop()
            $script:Window.FindName('DirectoryView').ScrollToTop()
        }
        $script:Previous.IsEnabled = $script:SelectedIndex -gt 0
        $script:Next.IsEnabled = $script:SelectedIndex -ge 0 -and $script:SelectedIndex -lt ($script:Requests.Count - 1)
        $script:Position.Text = [string]($script:SelectedIndex + 1) + ' / ' + [string]$script:Requests.Count
        $enabled = $null -ne $item -and -not $script:Submitted.ContainsKey($item.approval_id)
        $script:Approve.IsEnabled = $enabled
        $script:Reject.IsEnabled = $enabled
        $script:Options.Text = Format-Options $item
        if ($null -eq $item) {
            $script:Command.Text = ''
            $script:Directory.Text = ''
            Update-Content 'Command'
            Update-Content 'Directory'
            return
        }
        $script:Command.Text = [string]$item.command
        $script:Directory.Text = [string]$item.cwd
        Update-Content 'Command'
        Update-Content 'Directory'
    }
    # Every execution parameter the human approves, not just the command text.
    function Format-Options($item) {
        if ($null -eq $item -or $null -eq $item.parameters) { return '' }
        $p = $item.parameters
        $shell = if ($p.login) { 'Login shell (bash -lc, loads profile)' } else { 'Plain shell (bash -c)' }
        $mode = if ($p.run_in_background) { 'Background job' } else { 'Foreground' }
        $limit = if ($null -ne $p.timeout_ms) { 'Time limit ' + [string]$p.timeout_ms + ' ms' } elseif ($p.run_in_background) { 'No time limit' } else { 'Default time limit' }
        return $shell + '  |  ' + $mode + '  |  ' + $limit
    }
    function Update-Content([string]$name) {
        $text = $script:Window.FindName($name)
        $view = $script:Window.FindName($name + 'View')
        $button = $script:Window.FindName('Expand' + $name)
        $width = if ($view.ActualWidth -gt 0) { $view.ActualWidth } else { [Math]::Max(1, $script:Window.Width - 80) }
        $measure = New-Object Windows.Controls.TextBlock
        $measure.Text = $text.Text
        $measure.FontFamily = $text.FontFamily
        $measure.FontSize = $text.FontSize
        $measure.TextWrapping = 'Wrap'
        $measure.LineHeight = 24
        $measure.LineStackingStrategy = 'BlockLineHeight'
        $measure.Measure((New-Object Windows.Size($width, [double]::PositiveInfinity)))
        $overflow = $measure.DesiredSize.Height -gt 48
        if (-not $overflow) { $script:Expanded[$name] = $false }
        $button.Visibility = if ($overflow) { 'Visible' } else { 'Collapsed' }
        $button.Content = if ($script:Expanded[$name]) { 'Collapse' } else { 'Expand' }
        $view.MaxHeight = if ($script:Expanded[$name]) { [double]::PositiveInfinity } else { 48 }
    }
    function Get-Selection {
        if ($script:SelectedIndex -ge 0 -and $script:SelectedIndex -lt $script:Requests.Count) {
            return $script:Requests[$script:SelectedIndex]
        }
        return $null
    }
    function Set-Requests($requests) {
        $selected = Get-Selection
        $selectedId = if ($null -ne $selected) { $selected.approval_id } else { $null }
        $oldIndex = $script:SelectedIndex
        $script:Requests = @($requests)
        $script:SelectedIndex = -1
        for ($index = 0; $index -lt $script:Requests.Count; $index++) {
            if ($script:Requests[$index].approval_id -eq $selectedId) { $script:SelectedIndex = $index; break }
        }
        if ($script:SelectedIndex -lt 0 -and $script:Requests.Count -gt 0) {
            $script:SelectedIndex = [Math]::Min([Math]::Max(0, $oldIndex), $script:Requests.Count - 1)
        }
        Show-Selection
    }
    function Submit-Selection([string]$action) {
        $item = Get-Selection
        if ($null -eq $item -or $script:Submitted.ContainsKey($item.approval_id)) { return }
        $script:Submitted[$item.approval_id] = $true
        Show-Selection
        Send-Reply @{ type = 'decision'; id = [string]$item.approval_id; action = $action }
    }
    $script:Previous.Add_Click({
        if ($script:SelectedIndex -gt 0) { $script:SelectedIndex--; Show-Selection }
    })
    $script:Next.Add_Click({
        if ($script:SelectedIndex -lt ($script:Requests.Count - 1)) { $script:SelectedIndex++; Show-Selection }
    })
    $script:Window.FindName('ExpandCommand').Add_Click({
        $script:Expanded.Command = -not $script:Expanded.Command
        Update-Content 'Command'
    })
    $script:Window.FindName('ExpandDirectory').Add_Click({
        $script:Expanded.Directory = -not $script:Expanded.Directory
        Update-Content 'Directory'
    })
    $script:Window.FindName('CommandView').Add_SizeChanged({ Update-Content 'Command' })
    $script:Window.FindName('DirectoryView').Add_SizeChanged({ Update-Content 'Directory' })
    $script:Window.FindName('Close').Add_Click({ $script:Window.Close() })
    $script:Window.FindName('Minimize').Add_Click({ $script:Window.WindowState = 'Minimized' })
    $script:Window.FindName('TitleBar').Add_MouseLeftButtonDown({
        param($sender, $eventArgs)
        if ($script:Window.FindName('Close').IsMouseOver -or $script:Window.FindName('Minimize').IsMouseOver) { return }
        if ($eventArgs.ClickCount -eq 2) {
            $script:Window.WindowState = if ($script:Window.WindowState -eq 'Maximized') { 'Normal' } else { 'Maximized' }
        } else { $script:Window.DragMove() }
    })
    $script:Approve.Add_Click({ Submit-Selection 'approve' })
    $script:Reject.Add_Click({ Submit-Selection 'reject' })
    $script:Window.Add_ContentRendered({
        $script:Reject.Focus() | Out-Null
        Send-Reply @{ type = 'ready' }
    })
    $script:Window.Add_Closed({ Send-Reply @{ type = 'closed' } })

    # Validate actual XAML and controls without displaying or approving a request.
    if ($Validate) {
        foreach ($name in @('TitleBar','Minimize','Close','Previous','Next','Position','Command','Directory','Options','CommandView','DirectoryView','ExpandCommand','ExpandDirectory','Approve','Reject')) {
            if ($null -eq $script:Window.FindName($name)) { throw "Missing WPF control: $name" }
        }
        $preview = [pscustomobject]@{ approval_id = 'validate-only'; command = "echo preview`necho second-line";
            cwd = 'C:\preview'; category = 'ask-required'; reason = 'Validation only';
            parameters = [pscustomobject]@{ login = $true; timeout_ms = 30000; run_in_background = $true } }
        Set-Requests @($preview)
        if (-not $script:Approve.IsEnabled -or $script:Command.Text -ne $preview.command) { throw 'Selection did not render the original request' }
        if ($script:Options.Text -notmatch 'Login shell' -or $script:Options.Text -notmatch 'Background job' -or $script:Options.Text -notmatch '30000') { throw 'Options did not render the request parameters' }
        Submit-Selection 'reject'
        if ($script:Approve.IsEnabled -or $script:Reject.IsEnabled) { throw 'Duplicate selection remained enabled' }
        [Console]::Out.WriteLine('WPF layout validated')
        exit 0
    }

    [ApprovalInput]::Start()
    $script:Timer = New-Object Windows.Threading.DispatcherTimer
    $script:Timer.Interval = [TimeSpan]::FromMilliseconds(100)
    $script:Timer.Add_Tick({
        try {
            [string]$line = ''
            while ([ApprovalInput]::Lines.TryDequeue([ref]$line)) {
                $message = $line | ConvertFrom-Json
                if ($message.type -ne 'snapshot') { throw 'Invalid parent message' }
                Set-Requests @($message.requests)
            }
            if ([ApprovalInput]::Ended) { $script:Window.Close() }
        } catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            $script:Timer.Stop()
            # Exit as a failure, not as a human closing the window.
            [Environment]::Exit(1)
        }
    })
    $script:Timer.Start()
    $script:Window.ShowDialog() | Out-Null
    $script:Timer.Stop()
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
