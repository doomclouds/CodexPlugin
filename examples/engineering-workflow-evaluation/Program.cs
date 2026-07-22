using System.Text.Json;
using MeasurementWindow;

if (args is ["--self-test"])
{
    return SelfTests.Run();
}

if (args.Length > 1)
{
    Console.Error.WriteLine("Usage: MeasurementWindow [input.csv | --self-test]");
    return 2;
}

StreamReader? inputFile = null;

try
{
    TextReader input = Console.In;
    if (args.Length == 1)
    {
        inputFile = File.OpenText(args[0]);
        input = inputFile;
    }

    var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    foreach (var summary in MeasurementAggregator.Aggregate(MeasurementCsv.Read(input)))
    {
        Console.WriteLine(JsonSerializer.Serialize(summary, jsonOptions));
    }

    return 0;
}
catch (Exception exception) when (
    exception is FormatException or ArgumentException or IOException or UnauthorizedAccessException)
{
    Console.Error.WriteLine(exception.Message);
    return 1;
}
finally
{
    inputFile?.Dispose();
}
